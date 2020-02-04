if (typeof require !== 'undefined') {
  /* global require */
  if (typeof axios === 'undefined') axios = require('axios');
  if (typeof LRUCache === 'undefined') LRUCache = require('lru-cache');
}

(function(init) {
  'use strict';
  var isBrowser = typeof window !== 'undefined' && typeof window.document !== 'undefined';
  var isWebWorker = typeof self === 'object' && typeof WorkerGlobalScope === 'function' &&
    self instanceof WorkerGlobalScope;
  var isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
  var Hubkit = init(isNode);
  if (typeof angular !== 'undefined') {
    /* global angular */
    angular.module('hubkit', []).constant('Hubkit', Hubkit);
  } else if (isNode) {
    /* global module */
    module.exports = Hubkit;
  } else if (isWebWorker) {
    /* global self */
    self.Hubkit = Hubkit;
  } else if (isBrowser) {
    /* global window */
    window.Hubkit = Hubkit;
  } else {
    throw new Error('Unable to install Hubkit - no recognizable global object found');
  }
})(function(isNode) {
  'use strict';

  var NETWORK_ERROR_CODES = [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EADDRINFO', 'ESOCKETTIMEDOUT'
  ];

  var Hubkit = function(options) {
    options = defaults({}, options);
    defaults(options, Hubkit.defaults);
    // NodeJS doesn't set a userAgent by default but GitHub requires one.
    if (typeof require !== 'undefined' && !options.userAgent) {
      options.userAgent = 'Hubkit';
    }
    this.defaultOptions = options;
  };

  Hubkit.Stats = function() {
    this.reset();
  };

  Hubkit.Stats.prototype.reset = function() {
    this.hits = 0;
    this.misses = 0;
    this.hitsSize = 0;
    this.missesSize = 0;
  };

  Hubkit.Stats.prototype.record = function(isHit, size) {
    size = size || 1;
    if (isHit) {
      this.hits++;
      this.hitsSize += size;
    } else {
      this.misses++;
      this.missesSize += size;
    }
  };

  function computeRate(hits, misses) {
    var total = hits + misses;
    return total ? hits / total : 0;
  }

  Object.defineProperties(Hubkit.Stats.prototype, {
    hitRate: {get: function() {return computeRate(this.hits, this.misses);}},
    hitSizeRate: {get: function() {return computeRate(this.hitsSize, this.missesSize);}}
  });

  Hubkit.defaults = {
    method: 'GET', host: 'https://api.github.com', perPage: 100, allPages: true, maxTries: 3,
    maxItemSizeRatio: 0.1, metadata: Hubkit, stats: new Hubkit.Stats(), agent: false,
    corsSuccessFlags: {}
  };
  if (typeof LRUCache !== 'undefined') {
    Hubkit.defaults.cache =
      new LRUCache({max: 10000000, length: function(item) {return item.size;}});
  }
  Hubkit.RETRY = {};  // marker object
  Hubkit.DONT_RETRY = {};  // marker object

  Hubkit.prototype.request = function(path, options) {
    var self = this;
    options = defaults({}, options);
    defaults(options, this.defaultOptions);
    path = interpolatePath(path, options);

    var cachedItem = null, cacheKey, cacheable = options.cache && options.method === 'GET';
    if (cacheable) {
      // Pin cached value, in case it gets evicted during the request
      cacheKey = computeCacheKey(path, options);
      cachedItem = checkCache(options, cacheKey);
      if (cachedItem && (
        options.immutable ||
        !options.fresh && (Date.now() < cachedItem.expiry || cachedItem.promise)
      )) {
        if (options.stats) {
          if (cachedItem.promise) {
            cachedItem.promise.then(function() {
              var entry = options.cache.get(cacheKey);
              options.stats.record(true, entry ? entry.size : 1);
            }).catch(function() {
              options.stats.record(true);
            });
          } else {
            options.stats.record(true, cachedItem.size);
          }
        }
        return cachedItem.promise || Promise.resolve(cachedItem.value);
      }
    }

    var requestPromise = new Promise(function(resolve, reject) {
      var result, tries = 0;
      send(options.body, options._cause || 'initial');

      function handleError(error, res) {
        error.request = {method: options.method, url: path, headers: res && res.config.headers};
        if (error.request.headers) delete error.request.headers.authorization;
        if (cacheable && res && res.status) {
          options.cache.del(cacheKey);
          if (options.stats) options.stats.record(false);
        }
        // If the request failed due to CORS, it may be because it was both preflighted and
        // redirected.  Attempt to recover by reissuing it as a simple request without preflight,
        // which requires getting rid of all extraneous headers.
        if (cacheable &&
            /Network Error/.test(error.originalMessage)) {
          cacheable = false;
          retry();
          return;
        }
        var value;
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
          } else if (res && res.status === 403 && res.headers['x-ratelimit-remaining'] === '0' &&
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
        } else if (value === undefined || value === Hubkit.RETRY || value === Hubkit.DONT_RETRY) {
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
        Promise.resolve(options.onSend && options.onSend(cause)).then(function(timeout) {
          timeout = timeout || options.timeout;

          var rawData;
          var config = {
            url: path,
            method: options.method,
            timeout: timeout || 0,
            params: {},
            headers: {},
            transformResponse: [function(data) {
              rawData = data;
              return data;
            }].concat(axios.defaults.transformResponse),
          };
          addHeaders(config, options, cachedItem);

          // If we're paging through a query, the path contains the full query string already so we
          // need to wipe out any additional query params inserted by addHeaders above.  Also, if we
          // retry a page query the cause will become 'retry', so explicitly check options._cause as
          // well.
          if (cause === 'page' || options._cause === 'page') config.params = {};

          if (body) {
            if (options.method === 'GET') config.params = Object.assign(config.params, body);
            else config.data = body;
          }
          axios(config).then(function(res) {
            onComplete(res, rawData);
          }).catch(onError);
        }).catch(function(error) {
          reject(error);
        });
      }

      function formatError(origin, status, message) {
        if (!message) {
          message = status;
          status = null;
        }
        var prefix = origin + ' error' + (status ? ' ' + status : '');
        return prefix + ' on ' + options.method + ' ' + path.replace(/\?.*/, '') + ': ' +
          message;
      }

      function onError(error) {
        if (error.response) {
          return onComplete(error.response);
        }

        if (/Network Error/.test(error.message) &&
            (options.corsSuccessFlags[options.host] ||
              !cacheable && (options.method === 'GET' || options.method === 'HEAD'))
        ) {
          error.message = 'Request terminated abnormally, network may be offline';
        }
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
          } else if (!(res.status >= 200 && res.status < 300 || options.boolean &&
              res.status === 404 && res.data && res.data.message === 'Not Found') ||
              res.data && !res.data.data && res.data.errors) {
            if (cacheable) {
              options.cache.del(cacheKey);
              if (options.stats) options.stats.record(false);
            }
            if (res.status === 404 && typeof options.ifNotFound !== 'undefined') {
              resolve(options.ifNotFound);
            } else if (res.status === 410 && typeof options.ifGone !== 'undefined') {
              resolve(options.ifGone);
            } else {
              var errors = '', rateLimited = false;
              if (res.data && res.data.errors) {
                errors = [];
                for (var i = 0; i < res.data.errors.length; i++) {
                  var errorItem = res.data.errors[i];
                  if (errorItem.message) {
                    errors.push(errorItem.message);
                  } else if (errorItem.field && errorItem.code) {
                    errors.push('field ' + errorItem.field + ' ' + errorItem.code);
                  } else if (typeof errorItem === 'string') {
                    errors.push(errorItem);
                  }
                  if (errorItem.type === 'RATE_LIMITED') rateLimited = true;
                }
                errors = errors.join('; ');
                if (res.data.message) errors = ' (' + errors + ')';
              }
              var statusError = new Error(
                formatError('GitHub', res.status, (res.data && res.data.message || '') + errors)
              );
              statusError.status = res.status;
              if (res.status === 200) statusError.status = rateLimited ? 403 : 400;
              statusError.method = options.method;
              statusError.path = path;
              statusError.response = res;
              statusError.fingerprint =
                ['Hubkit', options.method, options.pathPattern, '' + res.status];
              handleError(statusError, res);
            }
          } else if (options.media === 'raw' && !/^text\/plain *;?/.test(res.headers['content-type'])) {
            // retry if github disregards 'raw'
            handleError(new Error(
              formatError('Hubkit', 'GitHub disregarded the \'raw\' media type')
            ), res);
          } else {
            var nextUrl;
            if (res.headers.link) {
              var match = /<([^>]+?)>;\s*rel="next"/.exec(res.headers.link);
              nextUrl = match && match[1];
              if (nextUrl && !(options.method === 'GET' || options.method === 'HEAD')) {
                throw new Error(formatError('Hubkit', 'paginated response for non-GET method'));
              }
            }
            if (!res.data && rawData && /\bformat=json\b/.test(res.headers['x-github-media-type'])) {
              res.data = JSON.parse(rawData);
            }
            if (/^https?:\/\/[^/]+\/graphql/.test(path)) {
              var data = res.data.data;
              var root = data, rootKeys = [];
              while (true) {
                if (!root || Array.isArray(root) || typeof root === 'string' ||
                    typeof root === 'number') {
                  root = undefined;
                  break;
                }
                var keys = Object.keys(root);
                if (keys.length !== 1) break;
                rootKeys.push(keys[0]);
                root = root[keys[0]];
                if (root && root.nodes) break;
              }
              var paginated = root && Array.isArray(root.nodes) && root.pageInfo &&
                /^\s*query[^({]*\((|[^)]*[(,\s])\$after\s*:\s*String[),\s]/.test(options.body.query);
              var resultRoot;
              if (paginated) {
                resultRoot = result && result.data;
                for (var p = 0; p < rootKeys.length; p++) {
                  if (resultRoot === undefined) break;
                  resultRoot = resultRoot[rootKeys[p]];
                }
              }
              if (result && !(paginated && resultRoot && Array.isArray(resultRoot.nodes))) {
                throw new Error(formatError('Hubkit', 'unable to concatenate paged results'));
              }
              if (paginated) {
                var endCursor = root.pageInfo.hasNextPage ? root.pageInfo.endCursor : undefined;
                if (!result) {
                  result = res.data;
                  delete root.pageInfo;
                } else {
                  resultRoot.nodes = resultRoot.nodes.concat(root.nodes);
                  for (var key in root) {
                    if (!root.hasOwnProperty(key) || key === 'nodes' || key === 'pageInfo') {
                      continue;
                    }
                    resultRoot[key] = root[key];
                  }
                  if (data.errors && data.errors.length) {
                    outer: for (var j = 0; j < data.errors.length; j++) {
                      var nextError = data.errors[j];
                      if (result.errors && result.errors.length) {
                        for (var k = 0; k < result.errors.length; k++) {
                          if (result.errors[k].message === nextError.message) continue outer;
                        }
                      }
                      result.errors = result.errors || [];
                      result.errors.push(nextError);
                    }
                  }
                }
                if (endCursor) {
                  if (options.allPages) {
                    cachedItem = null;
                    tries = 0;
                    options._cause = 'page';
                    options.body.variables = options.body.variables || {};
                    options.body.variables.after = endCursor;
                    send(options.body, 'page');
                    return;  // Don't resolve yet, more pages to come
                  }
                  result.next = function() {
                    return self.request(
                      path,
                      defaults({
                        _cause: 'page', body: defaults({
                          variables: defaults({
                            after: endCursor
                          }, options.body.variables)
                        }, options.body)
                      }, options)
                    );
                  };
                }
              } else {
                result = res.data;
              }
            } else if (res.data && (
              Array.isArray(res.data) || Array.isArray(res.data.items) ||
              Array.isArray(res.data.statuses)
            )) {
              if (!result) {
                result = res.data;
              } else if (Array.isArray(res.data) && Array.isArray(result)) {
                result = result.concat(res.data);
              } else if (Array.isArray(res.data.items) && Array.isArray(result.items)) {
                result.items = result.items.concat(res.data.items);
              } else if (Array.isArray(res.data.statuses) && Array.isArray(result.statuses)) {
                result.statuses = result.statuses.concat(res.data.statuses);
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
                result.next = function() {
                  return self.request(nextUrl, defaults({_cause: 'page', body: null}, options));
                };
              }
            } else {
              if (nextUrl || result) {
                throw new Error(formatError(
                  'Hubkit', 'unable to find array in paginated response'));
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
              var size = rawData ? rawData.length : (res.data ?
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
  };

  Hubkit.prototype.graph = function(query, options) {
    var postOptions = defaults({body: {query: query}}, options);
    postOptions.host =
      options.graphHost || options.host || this.defaultOptions.graphHost ||
      this.defaultOptions.host;
    if (options.variables) {
      postOptions.body.variables = options.variables;
      delete postOptions.variables;
    }
    return this.request('POST /graphql', postOptions);
  };

  function defaults(o1, o2) {
    var onError1 = o1 && o1.onError, onError2 = o2 && o2.onError;
    if (onError1 && onError2) {
      o1.onError = function(error) {
        var value1 = onError1(error), value2 = onError2(error);
        return value1 === undefined ? value2 : value1;
      };
    }
    for (var key in o2) {
      if (!(key in o1)) o1[key] = o2[key];
    }
    return o1;
  }

  Hubkit.prototype.interpolate = function(string, options) {
    options = options ? defaults(options, this.defaultOptions) : this.defaultOptions;
    return interpolate(string, options);
  };

  function interpolatePath(path, options) {
    var a = path.split(' ');
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
    string = string.replace(/:([a-z-_]+)|\{(.+?)\}/gi, function(match, v1, v2) {
      var v = (v1 || v2);
      var parts = v.split('.');
      var value = options;
      for (var i = 0; i < parts.length; i++) {
        if (!(parts[i] in value)) {
          throw new Error('Options missing variable "' + v + '" for path "' + string + '"');
        }
        value = value[parts[i]];
      }
      if (value) {
        parts = value.toString().split('/');
        for (i = 0; i < parts.length; i++) {
          parts[i] = encodeURIComponent(parts[i]);
        }
        value = parts.join('/');
      }
      return value;
    });
    return string;
  }

  function addHeaders(config, options, cachedItem) {
    if (cachedItem && cachedItem.eTag) config.headers['If-None-Match'] = cachedItem.eTag;
    if (isNode && options.agent) {
      config[/^https:/.test(options.host) ? 'httpsAgent' : 'httpAgent'] = options.agent;
    }
    if (options.token) {
      config.headers['Authorization'] = 'token ' + options.token;
    } else if (options.username && options.password) {
      config.auth = {
        username: options.username,
        password: options.password
      };
    } else if (options.clientId && options.clientSecret) {
      config.params['client_id'] = options.clientId;
      config.params['client_secret'] = options.clientSecret;
    }
    if (options.userAgent) config.headers['User-Agent'] = options.userAgent;
    if (options.media) config.headers['Accept'] = 'application/vnd.github.' + options.media;
    if (options.method === 'GET' || options.method === 'HEAD') {
      config.params['per_page'] = options.perPage;
    }
    if (!isNode && options.responseType) config.responseType = options.responseType;
    // Work around Firefox bug that forces caching.  We can't use Cache-Control because it's not
    // allowed by Github's cross-domain request headers, and because we want to keep our requests
    // simple to avoid CORS preflight whenever possible.
    // https://bugzilla.mozilla.org/show_bug.cgi?id=428916
    if (!isNode && (options.method === 'GET' || options.method === 'HEAD')) {
      config.params['_nocache'] = Math.round(Math.random() * 1000000);
    }
  }

  function extractMetadata(path, res, metadata) {
    if (!(res && metadata)) return;
    var rateName = /^https?:\/\/[^/]+\/search\//.test(path) ? 'searchRateLimit' :
      (/^https?:\/\/[^/]+\/graphql/.test(path) ? 'graphRateLimit' : 'rateLimit');
    metadata[rateName] = res.headers['x-ratelimit-limit'] &&
      parseInt(res.headers['x-ratelimit-limit'], 10);
    metadata[rateName + 'Remaining'] = res.headers['x-ratelimit-remaining'] &&
      parseInt(res.headers['x-ratelimit-remaining'], 10);
    // Not every response includes an X-OAuth-Scopes header, so keep the last known set if
    // missing.
    if ('x-oauth-scopes' in res.headers) {
      metadata.oAuthScopes = [];
      var scopes = (res.headers['x-oauth-scopes'] || '').split(/\s*,\s*/);
      if (!(scopes.length === 1 && scopes[0] === '')) {
        // GitHub will sometimes return duplicate scopes in the list, so uniquefy them.
        scopes.sort();
        metadata.oAuthScopes = [];
        for (var i = 0; i < scopes.length; i++) {
          if (i === 0 || scopes[i - 1] !== scopes[i]) metadata.oAuthScopes.push(scopes[i]);
        }
      }
    }
  }

  function parseExpiry(res) {
    var match = (res.headers['cache-control'] || '').match(/(^|[,\s])max-age=(\d+)/);
    if (match) return Date.now() + 1000 * parseInt(match[2], 10);
  }

  function computeCacheKey(url, options) {
    var cacheKey = url;
    var sortedQuery = ['per_page=' + options.perPage];
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
      for (var key in options.body) {
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

  return Hubkit;
});
