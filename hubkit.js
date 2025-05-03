if (typeof require !== 'undefined') {
  /* global require */
  if (typeof axios === 'undefined') axios = require('axios');
  if (typeof LRUCache === 'undefined') LRUCache = require('lru-cache');
}

(function() {
  'use strict';

  /* global process */
  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

  const NETWORK_ERROR_CODES = [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EADDRINFO', 'ESOCKETTIMEDOUT', 'ECONNABORTED',
    'ERR_NETWORK'
  ];

  class Directive {
    constructor(arg, body, options, hubkit) {
      this.arg = arg;
      this.body = body;
      this.options = options;
      this.hubkit = hubkit;
    }

    render() {
      const body = this.body;
      if (body === undefined) this.error('missing body');
      return Promise.resolve(this.check()).then(result => result ? body : '');
    }

    error(details) {
      throw new Error('Hubkit unable to process #' + this.directive + ' directive: ' + details);
    }
  }

  class GheDirective extends Directive {
    check() {
      if (!this.options.gheVersion) this.error('gheVersion missing');
      return satisfiesGheVersion(this.options, this.arg);
    }
  }

  class ScopeDirective extends Directive {
    check() {
      if (!this.options.scopes) this.error('scopes missing');
      return this.options.scopes.includes(this.arg);
    }
  }

  class ExistsDirective extends Directive {
    check() {
      const match = this.arg.match(/([^.]*)(?:\.(.*))?/);
      const type = match[1], field = match[2];
      return reflectGraphQLType(type, this.hubkit).then(fields => {
        if (field === undefined) return !!fields;
        if (!fields) this.error('unknown type ' + type);
        return fields.includes(field);
      });
    }
  }

  class FieldDirective extends Directive {
    render() {
      const args = this.arg.split(',').map(str => str.trim());
      if (args.length < 2) this.error('expected at least 2 arguments');
      return reflectGraphQLType(args[0], this.hubkit).then(fields => {
        if (!fields) this.error('unknown type ' + args[0]);
        for (const field of args.slice(1)) {
          if (fields.includes(field)) return field;
        }
        return '';
      });
    }
  }

  const directives = {
    ghe: GheDirective,
    scope: ScopeDirective,
    exists: ExistsDirective,
    field: FieldDirective
  };

  Object.keys(directives).forEach(directive => {
    directives[directive].prototype.directive = directive;
  });

  class Hubkit {
    constructor(options) {
      options = defaults({}, options);
      defaults(options, Hubkit.defaults);
      // NodeJS doesn't set a userAgent by default but GitHub requires one.
      if (typeof require !== 'undefined' && !options.userAgent) {
        options.userAgent = 'Hubkit';
      }
      this.defaultOptions = options;
    }

    static Stats = class {
      constructor() {
        this.reset();
      }

      reset() {
        this.hits = 0;
        this.misses = 0;
        this.hitsSize = 0;
        this.missesSize = 0;
      }

      record(isHit, size) {
        size = size || 1;
        if (isHit) {
          this.hits++;
          this.hitsSize += size;
        } else {
          this.misses++;
          this.missesSize += size;
        }
      }

      get hitRate() {
        return computeRate(this.hits, this.misses);
      }

      get hitSizeRate() {
        return computeRate(this.hitsSize, this.missesSize);
      }
    };

    static defaults = {
      method: 'GET', host: 'https://api.github.com', perPage: 100, allPages: true, maxTries: 3,
      maxItemSizeRatio: 0.1, metadata: Hubkit, stats: new Hubkit.Stats(), agent: false,
      corsSuccessFlags: {}, gheVersion: undefined, scopes: undefined, apiVersion: undefined
    };

    static RETRY = {};  // marker object
    static DONT_RETRY = {};  // marker object

    scope(options) {
      options = defaults({}, options);
      return new Hubkit(defaults(options, this.defaultOptions));
    }

    request(path, options) {
      const self = this;
      options = defaults({}, options);
      defaults(options, this.defaultOptions);

      return Promise.resolve(options.onRequest && options.onRequest(options)).then(() => {
        path = interpolatePath(path, options);

        let cachedItem = null, cacheKey, cacheable = options.cache && options.method === 'GET';
        if (cacheable) {
          // Pin cached value, in case it gets evicted during the request
          cacheKey = computeCacheKey(path, options);
          cachedItem = checkCache(options, cacheKey);
          if (cachedItem && (
            options.immutable || options.stale ||
            !options.fresh && (Date.now() < cachedItem.expiry || cachedItem.promise)
          )) {
            if (options.stats) {
              if (cachedItem.promise) {
                cachedItem.promise.then(() => {
                  const entry = options.cache.get(cacheKey);
                  options.stats.record(true, entry ? entry.size : 1);
                }).catch(() => {
                  options.stats.record(true);
                });
              } else {
                options.stats.record(true, cachedItem.size);
              }
            }
            return cachedItem.promise || Promise.resolve(cachedItem.value);
          }
        }

        const requestPromise = new Promise((resolve, reject) => {
          let result, tries = 0;
          send(options.body, options._cause || 'initial');

          function handleError(error, res) {
            error.request = {method: options.method, url: path, headers: res && res.headers};
            if (error.request.headers) delete error.request.headers.authorization;
            if (cacheable && res && res.status) {
              options.cache.del(cacheKey);
              if (options.stats) options.stats.record(false);
            }
            // If the request failed due to CORS, it may be because it was both preflighted and
            // redirected.  Attempt to recover by reissuing it as a simple request without
            // preflight, which requires getting rid of all extraneous headers.
            if (cacheable && /Network Error/.test(error.originalMessage)) {
              cacheable = false;
              retry();
              return;
            }
            let value;
            if (options.onError) value = options.onError(error);
            if (value === undefined) {
              if (NETWORK_ERROR_CODES.indexOf(error.code) >= 0 ||
                [500, 502, 503, 504].indexOf(res && res.status) >= 0 ||
                error.originalMessage === 'socket hang up' ||
                error.originalMessage === 'Unexpected end of input'
              ) {
                value = Hubkit.RETRY;
                options.agent = false;
              } else if (res && res.status === 403 && res.headers['retry-after']) {
                try {
                  error.retryDelay =
                    parseInt(res.headers['retry-after'].replace(/[^\d]*$/, ''), 10) * 1000;
                  if (!options.timeout || error.retryDelay < options.timeout) value = Hubkit.RETRY;
                } catch (e) {
                  // ignore, don't retry request
                }
              } else if (res && res.status === 403 &&
                  res.headers['x-ratelimit-remaining'] === '0' &&
                  res.headers['x-ratelimit-reset']) {
                try {
                  error.retryDelay =
                    Math.max(0, parseInt(res.headers['x-ratelimit-reset'], 10) * 1000 - Date.now());
                  if (!options.timeout || error.retryDelay < options.timeout) value = Hubkit.RETRY;
                } catch (e) {
                  // ignore, don't retry request
                }
              }
            }
            if (value === Hubkit.RETRY && tries < options.maxTries) {
              if (error.retryDelay) setTimeout(retry, error.retryDelay); else retry();
            } else if (value === undefined ||
                value === Hubkit.RETRY || value === Hubkit.DONT_RETRY) {
              reject(error);
            } else {
              resolve(value);
            }
          }

          function retry() {
            if (cacheable) cachedItem = checkCache(options, cacheKey);
            send(options.body, 'retry');
          }

          function send(body, cause) {
            tries++;
            Promise.resolve(options.onSend && options.onSend(cause)).then(timeout => {
              timeout = timeout || options.timeout;

              let rawData;
              const config = {
                url: path,
                method: options.method,
                timeout: timeout || 0,
                params: {},
                headers: {},
                transformResponse: [data => {
                  rawData = data;
                  // avoid axios default transform for 'raw'
                  // https://github.com/axios/axios/issues/907
                  if (options.media !== 'raw') {
                    return axios.defaults.transformResponse[0](data);
                  }
                  return data;
                }]
              };
              addHeaders(config, options, cachedItem);

              // If we're paging through a query, the path contains the full query string already so
              // we need to wipe out any additional query params inserted by addHeaders above.
              // Also, if we retry a page query the cause will become 'retry', so explicitly check
              // options._cause as well.
              if (cause === 'page' || options._cause === 'page') config.params = {};

              if (body) {
                if (options.method === 'GET') config.params = Object.assign(config.params, body);
                else config.data = body;
              }
              let received = false;
              axios(config).then(res => {
                received = true;
                if (options.onReceive) options.onReceive();
                onComplete(res, rawData);
              }).catch(e => {
                if (options.onReceive && !received) options.onReceive();
                onError(e);
              });
            }).catch(reject);
          }

          function formatError(origin, status, message) {
            if (!message) {
              message = status;
              status = null;
            }
            const prefix = origin + ' error' + (status ? ' ' + status : '');
            return prefix + ' on ' + options.method + ' ' + path.replace(/\?.*/, '') + ': ' +
              message;
          }

          function onError(error) {
            // If we get an error response without a status, then it's not a real error coming back
            // from the server but some kind of synthetic response Axios concocted for us.  Treat it
            // as a generic network error.
            if (error.response && error.response.status) return onComplete(error.response);

            if ((/Network Error/.test(error.message) || error.message === '0') &&
                (options.corsSuccessFlags[options.host] ||
                  !cacheable && (options.method === 'GET' || options.method === 'HEAD'))
            ) {
              error.message = 'Request terminated abnormally, network may be offline';
            }
            if (error.message === 'maxContentLength size of -1 exceeded') error.message = 'aborted';
            error.originalMessage = error.message;
            error.message = formatError('Hubkit', error.message);
            error.fingerprint =
              ['Hubkit', options.method, options.pathPattern, error.originalMessage];
            handleError(error);
          }

          function onComplete(res, rawData) {
            extractMetadata(path, res, options.metadata);
            if (res.headers['access-control-allow-origin']) {
              options.corsSuccessFlags[options.host] = true;
            }

            try {
              if (res.status === 304) {
                cachedItem.expiry = parseExpiry(res);
                if (options.stats) options.stats.record(true, cachedItem.size);
                resolve(cachedItem.value);
              } else if (
                !(res.status >= 200 && res.status < 300 ||
                  options.boolean && res.status === 404 && res.data &&
                    res.data.message === 'Not Found'
                ) || res.data && res.data.errors
              ) {
                if (cacheable) {
                  options.cache.del(cacheKey);
                  if (options.stats) options.stats.record(false);
                }
                let status = res.status;
                if (res.data && res.data.errors && res.status === 200) {
                  if (res.data.errors.every(error =>
                    error.type === 'RATE_LIMITED' || error.type === 'FORBIDDEN'
                  )) status = 403;
                  else if (res.data.errors.every(error =>
                    error.type === 'NOT_FOUND'
                  )) status = 404;
                  else if (res.data.errors.some(error =>
                    /^something went wrong/i.test(error.message)
                  )) status = 500;
                  else status = 400;
                }
                if (status === 404 && typeof options.ifNotFound !== 'undefined') {
                  resolve(options.ifNotFound);
                } else if (status === 410 && typeof options.ifGone !== 'undefined') {
                  resolve(options.ifGone);
                } else {
                  let errors = '';
                  if (res.data && res.data.errors) {
                    errors = [];
                    for (const errorItem of res.data.errors) {
                      if (errorItem.message) {
                        errors.push(errorItem.message);
                      } else if (errorItem.field && errorItem.code) {
                        errors.push('field ' + errorItem.field + ' ' + errorItem.code);
                      } else if (typeof errorItem === 'string') {
                        errors.push(errorItem);
                      }
                    }
                    errors = errors.join('; ');
                    if (res.data.message && errors) errors = ' (' + errors + ')';
                  }
                  const statusError = new Error(
                    formatError('GitHub', status, (res.data && res.data.message || '') + errors)
                  );
                  statusError.status = status;
                  if (res.data && res.data.errors) statusError.errors = res.data.errors;
                  if (res.data && res.data.data) statusError.data = res.data.data;
                  statusError.method = options.method;
                  if (options.body && options.body.query && /^\s*query/.test(options.body.query)) {
                    statusError.method = 'GET';
                  }
                  statusError.path = path;  // This is the fully expanded URL at this point.
                  statusError.pathPattern = options.pathPattern;
                  statusError.response = res;
                  if (options.logTag) statusError.logTag = options.logTag;
                  statusError.fingerprint =
                    ['Hubkit', options.method, options.logTag || options.pathPattern, '' + status];
                  handleError(statusError, res);
                }
              } else if (options.media === 'raw' && !(
                /^(?:text\/plain|application\/octet-stream) *;?/.test(res.headers['content-type'])
              )) {
                // retry if github disregards 'raw'
                handleError(new Error(
                  formatError('Hubkit', 'GitHub disregarded the \'raw\' media type')
                ), res);
              } else {
                let nextUrl;
                if (res.headers.link) {
                  const match = /<([^>]+?)>;\s*rel="next"/.exec(res.headers.link);
                  nextUrl = match && match[1];
                  if (nextUrl && !(options.method === 'GET' || options.method === 'HEAD')) {
                    throw new Error(formatError('Hubkit', 'paginated response for non-GET method'));
                  }
                }
                if (!res.data && rawData &&
                    /\bformat=json\b/.test(res.headers['x-github-media-type'])) {
                  res.data = JSON.parse(rawData);
                }
                if (isGraphqlUrl(path)) {
                  let root = res.data.data;
                  const rootKeys = [];
                  while (true) {
                    if (!root || Array.isArray(root) || typeof root === 'string' ||
                        typeof root === 'number') {
                      root = undefined;
                      break;
                    }
                    const keys = Object.keys(root);
                    if (keys.length !== 1) break;
                    rootKeys.push(keys[0]);
                    root = root[keys[0]];
                    if (root && root.nodes) break;
                  }
                  const paginated = root && Array.isArray(root.nodes) && root.pageInfo &&
                    /^\s*query[^({]*\((|[^)]*[(,\s])\$after\s*:\s*String[),\s]/.test(options.body.query);
                  let resultRoot;
                  if (paginated) {
                    resultRoot = result;
                    for (const key of rootKeys) {
                      if (resultRoot === undefined) break;
                      resultRoot = resultRoot[key];
                    }
                  }
                  if (result && !(paginated && resultRoot && Array.isArray(resultRoot.nodes))) {
                    throw new Error(formatError('Hubkit', 'unable to concatenate paged results'));
                  }
                  if (paginated) {
                    const cursor = root.pageInfo.hasNextPage ? root.pageInfo.endCursor : undefined;
                    if (result) {
                      resultRoot.nodes = resultRoot.nodes.concat(root.nodes);
                      for (const key in root) {
                        if (!Object.hasOwnProperty.call(root, key) ||
                            key === 'nodes' || key === 'pageInfo') {
                          continue;
                        }
                        resultRoot[key] = root[key];
                      }
                    } else {
                      result = res.data.data;
                      delete root.pageInfo;
                    }
                    if (cursor) {
                      if (options.allPages) {
                        cachedItem = null;
                        tries = 0;
                        options._cause = 'page';
                        options.body.variables = options.body.variables || {};
                        options.body.variables.after = cursor;
                        send(options.body, 'page');
                        return;  // Don't resolve yet, more pages to come
                      }
                      result.next = () => {
                        return self.request(
                          path,
                          defaults({
                            _cause: 'page', body: defaults({
                              variables: defaults({
                                after: cursor
                              }, options.body.variables)
                            }, options.body)
                          }, options)
                        );
                      };
                    }
                  } else {
                    result = res.data.data;
                  }
                } else if (res.data && (
                  Array.isArray(res.data) || Array.isArray(res.data.items) ||
                  Array.isArray(res.data.statuses) || Array.isArray(res.data.files)
                )) {
                  if (!result) {
                    result = res.data;
                  } else if (Array.isArray(res.data) && Array.isArray(result)) {
                    result = result.concat(res.data);
                  } else if (Array.isArray(res.data.items) && Array.isArray(result.items)) {
                    result.items = result.items.concat(res.data.items);
                  } else if (Array.isArray(res.data.statuses) && Array.isArray(result.statuses)) {
                    result.statuses = result.statuses.concat(res.data.statuses);
                  } else if (Array.isArray(res.data.files) && Array.isArray(result.files)) {
                    result.files = result.files.concat(res.data.files);
                  } else {
                    throw new Error(formatError('Hubkit', 'unable to concatenate paged results'));
                  }
                  if (nextUrl) {
                    if (options.allPages) {
                      cachedItem = null;
                      tries = 0;
                      path = nextUrl;
                      options._cause = 'page';
                      options.body = null;
                      send(null, 'page');
                      return;  // Don't resolve yet, more pages to come.
                    }
                    result.next = () => {
                      return self.request(nextUrl, defaults({_cause: 'page', body: null}, options));
                    };
                  }
                } else {
                  if (nextUrl || result) {
                    const error = new Error(formatError(
                      'Hubkit', 'unable to find array in paginated response'));
                    error.nextUrl = nextUrl;
                    error.accumulatedResult = result;
                    throw error;
                  }
                  if (options.boolean) {
                    result = res.status === 204;
                  } else {
                    result =
                      (options.responseType ||
                      res.data && typeof res.data === 'object' && Object.keys(res.data).length) ?
                        res.data : rawData;
                  }
                }
                if (cacheable) {
                  const size = rawData ? rawData.length : (res.data ?
                    (res.data.size || res.data.byteLength) : 1);
                  if (options.stats) options.stats.record(false, size);
                  if (res.status === 200 && (res.headers.etag || res.headers['cache-control']) &&
                      size <= options.cache.max * options.maxItemSizeRatio) {
                    options.cache.set(cacheKey, {
                      value: result, eTag: res.headers.etag, status: res.status, size: size,
                      expiry: parseExpiry(res)
                    });
                  } else {
                    options.cache.del(cacheKey);
                  }
                }
                resolve(result);
              }
            } catch (e) {
              handleError(e, res);
            }
          }
        });

        if (cacheable) options.cache.set(cacheKey, {promise: requestPromise, size: 100});
        return requestPromise;
      });
    }

    graph(query, options) {
      options = options || {};
      const fullOptions = Object.assign({}, this.defaultOptions, options);
      return Promise.resolve(
        fullOptions.onRequest && fullOptions.onRequest(fullOptions)
      ).then(() => {
        return replaceAsync(query, /#(\w+)\s*\(([^)]+)\)(?:\s*\{([\s\S]*?)#\})?/g,
          (match, directive, arg, body) => {
            if (!Object.prototype.hasOwnProperty.call(directives, directive)) {
              throw new Error('Unknown Hubkit GraphQL preprocessing directive: #' + directive);
            }
            return (new directives[directive](arg, body, fullOptions, this)).render();
          });
      }).then(finalQuery => {
        if (/#(\w+)\s*\(([^)]+)\)/.test(finalQuery)) {
          throw new Error(
            'Hubkit preprocessing directives may not ' +
            'have been correctly terminated: ' + finalQuery);
        }
        const postOptions = defaults({body: {query: finalQuery}}, options);
        delete postOptions.onRequest;
        postOptions.host =
          options.graphHost || options.host || this.defaultOptions.graphHost ||
          this.defaultOptions.host;
        if (options.variables) {
          postOptions.body.variables = options.variables;
          delete postOptions.variables;
        }
        return this.request('POST /graphql', postOptions);
      });
    }

    interpolate(string, options) {
      options = options ? defaults(options, this.defaultOptions) : this.defaultOptions;
      return interpolate(string, options);
    }
  }

  function computeRate(hits, misses) {
    const total = hits + misses;
    return total ? hits / total : 0;
  }

  if (typeof LRUCache !== 'undefined') {
    Hubkit.defaults.cache =
      new LRUCache({max: 10000000, length: item => item.size});
  }

  function replaceAsync(str, regex, replacerFn) {
    const promises = [];
    str.replace(regex, (match, ...args) => {
      promises.push(new Promise(resolve => resolve(replacerFn(match, ...args))));
      return match;
    });
    return Promise.all(promises).then(
      substitutions => str.replace(regex, () => substitutions.shift()));
  }

  function isGraphqlUrl(url) {
    return /^https?:\/\/[^/]+(?:\/api)?\/graphql/.test(url);
  }

  function defaults(o1, o2) {
    const onError1 = o1 && o1.onError, onError2 = o2 && o2.onError;
    if (onError1 && onError2) {
      o1.onError = error => {
        const value1 = onError1(error);
        if (value1 !== undefined) return value1;
        return onError2(error);
      };
    }
    for (const key in o2) {
      if (!(key in o1)) o1[key] = o2[key];
    }
    return o1;
  }

  function interpolatePath(path, options) {
    const a = path.split(' ');
    if (a.length === 2) {
      options.method = a[0];
      path = a[1];
    }
    options.method = options.method.toUpperCase();
    options.pathPattern = path;
    path = interpolate(path, options);
    if (!/^http/.test(path)) path = options.host + path;
    return path;
  }

  function interpolate(string, options) {
    string = string.replace(/:([a-z-_]+)|\{(.+?)\}/gi, (match, v1, v2) => {
      const v = (v1 || v2);
      let value = options;
      for (const part of v.split('.')) {
        if (!(part in value)) {
          throw new Error('Options missing variable "' + v + '" for path "' + string + '"');
        }
        value = value[part];
      }
      if (value === null || value === undefined) {
        throw new Error('Variable "' + v + '" is ' + value + ' for path "' + string + '"');
      }
      return value.toString().split('/').map(encodeURIComponent).join('/');
    });
    return string;
  }

  function addHeaders(config, options, cachedItem) {
    /* eslint-disable dot-notation */
    if (cachedItem && cachedItem.eTag) config.headers['If-None-Match'] = cachedItem.eTag;
    if (isNode && options.agent) {
      config[/^https:/.test(options.host) ? 'httpsAgent' : 'httpAgent'] = options.agent;
    }
    if (options.token) {
      config.headers['Authorization'] = 'token ' + options.token;
    } else if (options.username && options.password) {
      throw new Error('Username / password authentication is no longer supported');
    } else if (options.clientId && options.clientSecret) {
      config.auth = {
        username: options.clientId,
        password: options.clientSecret
      };
    }
    if (options.userAgent) config.headers['User-Agent'] = options.userAgent;
    if (options.media) config.headers['Accept'] = 'application/vnd.github.' + options.media;
    if (options.method === 'GET' || options.method === 'HEAD') {
      config.params['per_page'] = options.perPage;
    }
    if (!isNode && options.responseType) config.responseType = options.responseType;
    // We can't use Cache-Control because it's not
    // allowed by Github's cross-domain request headers
    if (!isNode && (options.method === 'GET' || options.method === 'HEAD')) {
      config.params['_nocache'] = Math.round(Math.random() * 1000000);
    }
    if (options.apiVersion && satisfiesGheVersion(options, '3.9')) {
      config.headers['X-GitHub-Api-Version'] = options.apiVersion;
    }
    /* eslint-enable dot-notation */
  }

  function extractMetadata(path, res, metadata) {
    if (!(res && metadata)) return;
    const rateName = /^https?:\/\/[^/]+\/search\//.test(path) ? 'searchRateLimit' :
      (isGraphqlUrl(path) ? 'graphRateLimit' : 'rateLimit');
    metadata[rateName] = res.headers['x-ratelimit-limit'] &&
      parseInt(res.headers['x-ratelimit-limit'], 10);
    metadata[rateName + 'Remaining'] = res.headers['x-ratelimit-remaining'] &&
      parseInt(res.headers['x-ratelimit-remaining'], 10);
    // Not every response includes an X-OAuth-Scopes header, so keep the last known set if
    // missing.
    if ('x-oauth-scopes' in res.headers) {
      metadata.oAuthScopes = [];
      const scopes = (res.headers['x-oauth-scopes'] || '').split(/\s*,\s*/);
      if (!(scopes.length === 1 && scopes[0] === '')) {
        // GitHub will sometimes return duplicate scopes in the list, so uniquefy them.
        scopes.sort();
        metadata.oAuthScopes = [];
        for (let i = 0; i < scopes.length; i++) {
          if (i === 0 || scopes[i - 1] !== scopes[i]) metadata.oAuthScopes.push(scopes[i]);
        }
      }
    }
  }

  function parseExpiry(res) {
    const match = (res.headers['cache-control'] || '').match(/(^|[,\s])max-age=(\d+)/);
    if (match) return Date.now() + 1000 * parseInt(match[2], 10);
  }

  function computeCacheKey(url, options) {
    let cacheKey = url;
    const sortedQuery = ['per_page=' + options.perPage];
    if (options.token) {
      sortedQuery.push('_token=' + options.token);
    } else if (options.username && options.password) {
      sortedQuery.push('_login=' + options.username + ':' + options.password);
    }
    if (options.boolean) sortedQuery.push('_boolean=true');
    if (options.allPages) sortedQuery.push('_allPages=true');
    if (options.responseType) sortedQuery.push('_responseType=' + options.responseType);
    if (options.media) sortedQuery.push('_media=' + encodeURIComponent(options.media));
    if (options.body) {
      for (const key in options.body) {
        sortedQuery.push(encodeURIComponent(key) + '=' + encodeURIComponent(options.body[key]));
      }
    }
    sortedQuery.sort();
    cacheKey += (/\?/.test(cacheKey) ? '&' : '?') + sortedQuery.join('&');
    return cacheKey;
  }

  function checkCache(options, cacheKey) {
    return options.cache.get(cacheKey);
  }

  function satisfiesGheVersion(options, minVersion) {
    if (options.host === 'https://api.github.com') return true;
    if (!options.gheVersion) return false;
    const neededVersion = minVersion.split('.').map(x => parseInt(x, 10));
    const actualVersion = options.gheVersion.split('.').map(x => parseInt(x, 10));
    return actualVersion[0] > neededVersion[0] ||
      actualVersion[0] === neededVersion[0] && actualVersion[1] >= neededVersion[1];
  }

  const schemaCache = {};
  function reflectGraphQLType(type, hubkit) {
    if (Object.prototype.hasOwnProperty.call(schemaCache, type)) return schemaCache[type];
    const fieldsPromise = schemaCache[type] = hubkit.graph(
      'query ($type: String!) { __type(name: $type) { fields { name } } }',
      {variables: {type: type}}
    ).then(
      result => {
        return result.__type && (result.__type.fields || []).map(field => field.name);
      },
      error => {
        delete schemaCache[type];
        throw error;
      });
    return fieldsPromise;
  }

  if (typeof angular !== 'undefined') {
    /* global angular */
    angular.module('hubkit', []).constant('Hubkit', Hubkit);
  } else if (isNode) {
    /* global module */
    module.exports = Hubkit;
  } else if (typeof self === 'undefined') {
    throw new Error('Unable to install Hubkit - no recognizable global object found');
  } else {
    /* global self */
    self.Hubkit = Hubkit;
  }
})();
