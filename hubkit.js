if (typeof require !== 'undefined') {
  if (typeof Promise === 'undefined') require('es6-promise').polyfill();
  if (typeof superagent === 'undefined') superagent = require('superagent-ls');
  if (typeof LRUCache === 'undefined') LRUCache = require('serialized-lru-cache');
}

(function(init) {
  'use strict';
  var Hubkit = init();
  if (typeof angular !== 'undefined') {
    var glob = this;
    angular.module('hubkit', []).factory('Hubkit', ['$q', '$rootScope', function($q, $rootScope) {
      glob.Promise = function(fn) {
        var deferred = $q.defer();
        fn(
          function(value) {deferred.resolve(value);},
          function(reason) {deferred.reject(reason);}
        );
        return deferred.promise;
      };

      glob.Promise.all = $q.all.bind($q);
      glob.Promise.reject = $q.reject.bind($q);
      glob.Promise.resolve = $q.when.bind($q);

      glob.Promise.race = function(promises) {
        var promiseMgr = $q.defer();
        for(var i = 0; i < promises.length; i++) {
          promises[i].then(function(result) {
            if (promiseMgr) {
              promiseMgr.resolve(result);
              promiseMgr = null;
            }
          });
          promises[i].catch(function(result) {
            if (promiseMgr) {
              promiseMgr.reject(result);
              promiseMgr = null;
            }
          });
        }
        return promiseMgr.promise;
      };

      return Hubkit;
    }]);
  } else if (typeof module !== 'undefined') {
    module.exports = Hubkit;
  } else {
    this.Hubkit = Hubkit;
  }
  superagent.parse['text/plain'] = function(o) {return o;};
}).call(this, function() {
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
    maxItemSizeRatio: 0.1, metadata: Hubkit, stats: new Hubkit.Stats()
  };
  if (typeof LRUCache !== 'undefined') {
    Hubkit.defaults.cache =
      new LRUCache({max: 10000000, length: function(item) {return item.size;}});
  }
  Hubkit.RETRY = {};  // marker object

  Hubkit.prototype.request = function(path, options) {
    var self = this;
    options = defaults({}, options);
    defaults(options, this.defaultOptions);
    path = interpolatePath(path, options);
    var req = superagent(options.method, path);
    addHeaders(req, options);
    var cachedItem = null, cacheKey, cacheable = options.cache && options.method === 'GET';
    if (cacheable) {
      // Pin cached value, in case it gets evicted during the request
      cacheKey = computeCacheKey(req, options);
      cachedItem = checkCache(req, options, cacheKey);
      if (cachedItem && (
          options.immutable ||
          !options.fresh && (Date.now() < cachedItem.expiry || cachedItem.promise)
      )) {
        // Abort is needed only in Node implementation, check for req.req vs req.xhr.
        if (req.req) req.abort();
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
      var result = [], tries = 0;
      send(options.body);

      function handleError(error) {
        if (cacheable) {
          options.cache.del(cacheKey);
          if (options.stats) options.stats.record(false);
        }
        var value;
        if (options.onError) value = options.onError(error);
        if (value === Hubkit.RETRY && tries < options.maxTries) {
          req = superagent(options.method, path);
          addHeaders(req, options);
          req.set('If-Modified-Since', 'Sat, 1 Jan 2000 00:00:00 GMT');
          send(options.body);
          return;
        }
        if (value === undefined || value === Hubkit.RETRY) reject(error); else resolve(value);
      }

      function send(body) {
        tries++;
        if (options.timeout) req.timeout(options.timeout);
        if (body) req[options.method === 'GET' ? 'query' : 'send'](body);
        req.end(onComplete);
      }

      function onComplete(error, res) {
        extractMetadata(path, res, options.metadata);
        if (error) {
          error.message = 'HubKit error on ' + options.method + ' ' + path + ': ' + error.message;
          handleError(error);
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
              'GitHub error ' + res.status + ' on ' + options.method + ' ' + path + ': ' +
              (res.body && res.body.message) + errors
            );
            statusError.status = res.status;
            statusError.method = options.method;
            statusError.path = path;
            statusError.response = res;
            handleError(statusError);
          }
        } else {
          if (!res.body && res.text && /\bformat=json\b/.test(res.header['x-github-media-type'])) {
            res.body = JSON.parse(res.text);
          }
          if (res.body && Array.isArray(res.body)) {
            // Append to current result in case we're paging through.
            result.push.apply(result, res.body);
          } else if (options.boolean) {
            result = !!res.noContent;
          } else {
            result = (options.responseType ||
                      res.body && typeof res.body === 'object' && Object.keys(res.body).length) ?
              res.body : res.text;
          }
          if (res.header.link) {
            var match = /<(.+?)>;\s*rel="next"/.exec(res.header.link);
            if (match) {
              if (options.allPages) {
                req = superagent(options.method, match[1]);
                addHeaders(req, options);
                cachedItem = null;
                tries = 0;
                req.set('If-Modified-Since', 'Sat, 1 Jan 2000 00:00:00 GMT');
                send();
                return;  // Don't resolve yet, more pages to come.
              } else {
                result.next = function() {
                  return self.request(match[1], options);
                };
              }
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
    path = interpolate(path, options);
    if (!/^http/.test(path)) path = options.host + path;
    return encodeURI(path);
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
      return value;
    });
    return string;
  }

  function addHeaders(req, options) {
    if (options.token) req.set('Authorization', 'token ' + options.token);
    if (!options.token && options.username && options.password) {
      req.auth(options.username, options.password);
    }
    if (options.userAgent) req.set('User-Agent', options.userAgent);
    if (options.media) req.accept('application/vnd.github.' + options.media);
    req.query({per_page: options.perPage});
    if (options.responseType) req.on('request', function() {
      this.xhr.responseType = options.responseType;
    });
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

  function computeCacheKey(req, options) {
    var cacheKey = req.url;
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

  function checkCache(req, options, cacheKey) {
    var cachedItem = options.cache.get(cacheKey);
    if (cachedItem && cachedItem.eTag) {
      req.set('If-None-Match', cachedItem.eTag);
    } else {
      // Work around Firefox bug that forces caching.  We can't use Cache-Control because it's not
      // allowed by Github's cross-domain request headers.
      // https://bugzilla.mozilla.org/show_bug.cgi?id=428916
      req.set('If-Modified-Since', 'Sat, 1 Jan 2000 00:00:00 GMT');
    }
    return cachedItem;
  }

  return Hubkit;
});
