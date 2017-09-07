if (typeof require !== 'undefined') {
  if (typeof superagent === 'undefined') superagent = require('superagent');
  if (typeof LRUCache === 'undefined') LRUCache = require('lru-cache');
}

(function(init) {
  'use strict';
  var Hubkit = init();
  if (typeof angular !== 'undefined') {
    angular.module('hubkit', []).constant('Hubkit', Hubkit);
  } else if (typeof module !== 'undefined') {
    module.exports = Hubkit;
  } else if (typeof self !== 'undefined') {
    self.Hubkit = Hubkit;
  } else if (typeof window !== 'undefined') {
    window.Hubkit = Hubkit;
  } else {
    throw new Error('Unable to install Hubkit - no recognizable global object found');
  }
  superagent.parse['text/plain'] = function(o) {return o;};
})(function() {
  'use strict';

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
    method: 'get', host: 'https://api.github.com', perPage: 100, allPages: true, maxTries: 3,
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
    var req;
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
        error.request = {method: req.method, url: req.url, headers: res && res.req._headers};
        if (error.request.headers) delete error.request.headers.authorization;
        if (cacheable && error.status) {
          options.cache.del(cacheKey);
          if (options.stats) options.stats.record(false);
        }
        // If the request failed due to CORS, it may be because it was both preflighted and
        // redirected.  Attempt to recover by reissuing it as a simple request without preflight,
        // which requires getting rid of all extraneous headers.
        if (cacheable &&
            /Origin is not allowed by Access-Control-Allow-Origin/.test(error.originalMessage)) {
          cacheable = false;
          retry();
          return;
        }
        var value;
        if (options.onError) value = options.onError(error);
        if (value === undefined) {
          if ([
                'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EADDRINFO', 'ESOCKETTIMEDOUT'
              ].indexOf(error.code) >= 0 ||
              [500, 502, 503, 504].indexOf(error.status) >= 0 ||
              error.originalMessage === 'socket hang up' ||
              error.originalMessage === 'Unexpected end of input') {
            value = Hubkit.RETRY;
            options.agent = false;
          } else if (error.status === 403 && res && res.header['retry-after']) {
            try {
              error.retryDelay =
                parseInt(res.header['retry-after'].replace(/[^\d]*$/, ''), 10) * 1000;
              if (!options.timeout || error.retryDelay < options.timeout) value = Hubkit.RETRY;
            } catch(e) {
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
          req = superagent(options.method, path);
          addHeaders(req, options, cachedItem);
          // If we're paging through a query, the path contains the full query string already so we
          // need to wipe out any additional query params inserted by addHeaders above.  Also, if we
          // retry a page query the cause will become 'retry', so explicitly check options._cause as
          // well.
          if (cause === 'page' || options._cause === 'page') req._query = [];
          if (timeout) req.timeout(timeout);
          if (body) req[options.method === 'GET' ? 'query' : 'send'](body);
          req.end(onComplete);
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

      function onComplete(error, res) {
        if (error && error.response) {
          res = error.response;
          error = null;
        }
        extractMetadata(path, res, options.metadata);
        if (!error && res.header['access-control-allow-origin']) {
          options.corsSuccessFlags[options.host] = true;
        }
        if (error) {
          if (/Origin is not allowed by Access-Control-Allow-Origin/.test(error.message) && (
                options.corsSuccessFlags[options.host] ||
                !cacheable && (options.method === 'GET' || options.method === 'HEAD')
          )) {
            error.message = 'Request terminated abnormally, network may be offline';
          }
          error.originalMessage = error.message;
          error.message = formatError('Hubkit', error.message);
          error.fingerprint =
            ['Hubkit', options.method, options.pathPattern, error.originalMessage];
          handleError(error, res);
        } else if (res.status === 304) {
          cachedItem.expiry = parseExpiry(res);
          if (options.stats) options.stats.record(true, cachedItem.size);
          resolve(cachedItem.value);
        } else if (!(res.ok || options.boolean && res.notFound && res.body &&
            res.body.message === 'Not Found')) {
          if (cacheable) {
            options.cache.del(cacheKey);
            if (options.stats) options.stats.record(false);
          }
          if (res.status === 404 && typeof options.ifNotFound !== 'undefined') {
            resolve(options.ifNotFound);
          } else if (res.status === 410 && typeof options.ifGone !== 'undefined') {
            resolve(options.ifGone);
          } else {
            var errors = '';
            if (res.body && res.body.errors) {
              errors = [];
              for (var i = 0; i < res.body.errors.length; i++) {
                var errorItem = res.body.errors[i];
                if (errorItem.message) {
                  errors.push(errorItem.message);
                } else if (errorItem.field && errorItem.code) {
                  errors.push('field ' + errorItem.field + ' ' + errorItem.code);
                }
              }
              errors = ' (' + errors.join(', ') + ')';
            }
            var statusError = new Error(
              formatError('GitHub', res.status, (res.body && res.body.message) + errors)
            );
            statusError.status = res.status;
            statusError.method = options.method;
            statusError.path = path;
            statusError.response = res;
            statusError.fingerprint =
              ['Hubkit', options.method, options.pathPattern, '' + res.status];
            handleError(statusError, res);
          }
        } else {
          var nextUrl;
          if (res.header.link) {
            var match = /<(.+?)>;\s*rel="next"/.exec(res.header.link);
            nextUrl = match && match[1];
            if (nextUrl && !(options.method == 'GET' || options.method === 'HEAD')) {
              throw new Error(formatError('Hubkit', 'paginated response for non-GET method'));
            }
          }
          if (!res.body && res.text && /\bformat=json\b/.test(res.header['x-github-media-type'])) {
            res.body = JSON.parse(res.text);
          }
          if (res.body && (Array.isArray(res.body) || Array.isArray(res.body.items))) {
            if (!result) {
              result = res.body;
            } else if (Array.isArray(res.body) && Array.isArray(result)) {
              result = result.concat(res.body);
            } else if (Array.isArray(res.body.items) && Array.isArray(result.items)) {
              result.items = result.items.concat(res.body.items);
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
              } else {
                result.next = function() {
                  return self.request(nextUrl, defaults({_cause: 'page', body: null}, options));
                };
              }
            }
          } else {
            if (nextUrl || result) {
              throw new Error(formatError(
                'Hubkit', 'unable to find array in paginated response'));
            }
            if (options.boolean) {
              result = !!res.noContent;
            } else {
              result = (options.responseType ||
                        res.body && typeof res.body === 'object' && Object.keys(res.body).length) ?
                res.body : res.text;
            }
          }
          if (cacheable) {
            var size = res.text ? res.text.length : (res.body ?
                (res.body.size || res.body.byteLength) : 1);
            if (options.stats) options.stats.record(false, size);
            if (res.status === 200 && (res.header.etag || res.header['cache-control']) &&
                size <= options.cache.max * options.maxItemSizeRatio) {
              options.cache.set(cacheKey, {
                value: result, eTag: res.header.etag, status: res.status, size: size,
                expiry: parseExpiry(res)
              });
            } else {
              options.cache.del(cacheKey);
            }
          }
          resolve(result);
        }
      }
    });

    if (cacheable) options.cache.set(cacheKey, {promise: requestPromise, size: 100});
    return requestPromise;

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

  function addHeaders(req, options, cachedItem) {
    if (cachedItem && cachedItem.eTag) req.set('If-None-Match', cachedItem.eTag);
    if (req.agent) req.agent(options.agent);
    if (options.token) {
      if (typeof module === 'undefined' && (
          options.method === 'GET' || options.method === 'HEAD')) {
        req.query({'access_token': options.token});
      } else {
        req.set('Authorization', 'token ' + options.token);
      }
    } else if (options.username && options.password) {
      req.auth(options.username, options.password);
    } else if (options.clientId && options.clientSecret) {
      req.query({'client_id': options.clientId, 'client_secret': options.clientSecret});
    }
    if (options.userAgent) req.set('User-Agent', options.userAgent);
    if (options.media) req.accept('application/vnd.github.' + options.media);
    req.query({per_page: options.perPage});
    if (options.responseType) req.on('request', function() {
      this.xhr.responseType = options.responseType;
    });
    // Work around Firefox bug that forces caching.  We can't use Cache-Control because it's not
    // allowed by Github's cross-domain request headers, and because we want to keep our requests
    // simple to avoid CORS preflight whenever possible.
    // https://bugzilla.mozilla.org/show_bug.cgi?id=428916
    if (typeof module === 'undefined') {
      req.query({'_nocache': Math.round(Math.random() * 1000000)});
    }
  }

  function extractMetadata(path, res, metadata) {
    if (!(res && metadata)) return;
    var rateName = /^https?:\/\/[^/]+\/search\//.test(path) ? 'searchRateLimit' : 'rateLimit';
    metadata[rateName] = res.header['x-ratelimit-limit'] &&
      parseInt(res.header['x-ratelimit-limit'], 10);
    metadata[rateName + 'Remaining'] = res.header['x-ratelimit-remaining'] &&
      parseInt(res.header['x-ratelimit-remaining'], 10);
    // Not every response includes an X-OAuth-Scopes header, so keep the last known set if
    // missing.
    if ('x-oauth-scopes' in res.header) {
      metadata.oAuthScopes = [];
      var scopes = (res.header['x-oauth-scopes'] || '').split(/\s*,\s*/);
      if (!(scopes.length === 1 && scopes[0] === '')) {
        // GitHub will sometimes return duplicate scopes in the list, so uniquefy them.
        scopes.sort();
        metadata.oAuthScopes = [];
        for (var i = 0; i < scopes.length; i++) {
          if (i === 0 || scopes[i-1] !== scopes[i]) metadata.oAuthScopes.push(scopes[i]);
        }
      }
    }
  }

  function parseExpiry(res) {
    var match = (res.header['cache-control'] || '').match(/(^|[,\s])max-age=(\d+)/);
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
