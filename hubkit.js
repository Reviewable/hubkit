if (typeof require !== 'undefined') {
  require('es6-promise').polyfill();
  if (typeof superagent === 'undefined') superagent = require('superagent-ls');
  if (typeof LRUCache === 'undefined') LRUCache = require('lru-cache');
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
      return Hubkit;
    }]);
  } else if (typeof module !== 'undefined') {
    module.exports = Hubkit;
  } else {
    this.Hubkit = Hubkit;
  }
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

  Hubkit.defaults = {
    method: 'get', host: 'https://api.github.com', perPage: 100, allPages: true, maxTries: 3
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
    var cachedItem = null;
    if (options.cache) {
      // Pin cached value, in case it gets evicted during the request
      cachedItem = checkCache(req, options);
      if (options.immutable && options.method === 'GET' && cachedItem) {
        // Abort is needed only in Node implementation, check for req.req vs req.xhr.
        if (req.req) req.abort();
        return cachedItem.promise || Promise.resolve(cachedItem.value);
      }
    } else {
      // Work around Firefox bug that forces caching.  We can't use Cache-Control because it's not
      // allowed by Github's cross-domain request headers.
      // https://bugzilla.mozilla.org/show_bug.cgi?id=428916
      req.set('If-Modified-Since', 'Sat, 1 Jan 2000 00:00:00 GMT');
    }

    var requestPromise = new Promise(function(resolve, reject) {
      var result = [], tries = 0;
      send();

      function handleError(error) {
        if (options.cache && options.method === 'GET') options.cache.del(path);
        var value;
        if (options.onError) value = options.onError(error);
        if (value === Hubkit.RETRY && tries < options.maxTries) {
          req = superagent(options.method, path);
          addHeaders(req, options);
          req.set('If-Modified-Since', 'Sat, 1 Jan 2000 00:00:00 GMT');
          send();
          return;
        }
        if (value === undefined || value === Hubkit.RETRY) reject(error); else resolve(value);
      }

      function send() {
        tries++;
        if (options.timeout) req.timeout(options.timeout);
        if (options.method === 'GET') {
          req.query(options.body).end(onComplete);
        } else {
          req.send(options.body).end(onComplete);
        }
      }

      function onComplete(error, res) {
        var rateName = /^https?:\/\/[^/]+\/search\//.test(path) ? 'searchRateLimit' : 'rateLimit';
        Hubkit[rateName] = res && res.header['x-ratelimit-limit'] &&
          parseInt(res.header['x-ratelimit-limit'], 10);
        Hubkit[rateName + 'Remaining'] = res && res.header['x-ratelimit-remaining'] &&
          parseInt(res.header['x-ratelimit-remaining'], 10);
        // Not every response includes an X-OAuth-Scopes header, so keep the last known set if
        // missing.
        if (res && 'x-oauth-scopes' in res.header) {
          var scopes = (res.header['x-oauth-scopes'] || '').split(/\s*,\s*/);
          if (scopes.length === 1 && scopes[0] === '') {
            Hubkit.oAuthScopes = [];
          } else {
            // GitHub will sometimes return duplicate scopes in the list, so uniquefy them.
            scopes.sort();
            Hubkit.oAuthScopes = [];
            for (var i = 0; i < scopes.length; i++) {
              if (i === 0 || scopes[i-1] !== scopes[i]) Hubkit.oAuthScopes.push(scopes[i]);
            }
          }
        }
        if (error) {
          error.message = 'HubKit error on ' + options.method + ' ' + path + ': ' + error.message;
          handleError(error);
        } else if (res.status === 304) {
          resolve(cachedItem.value);
        } else if (!(res.ok || options.boolean && res.notFound && res.body &&
            res.body.message === 'Not Found')) {
          if (res.status === 404 && typeof options.ifNotFound !== 'undefined') {
            resolve(options.ifNotFound);
          } else {
            var errors = '';
            if (res.body.errors) {
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
            result = (res.body && Object.keys(res.body).length) ? res.body : res.text;
          }
          if (res.status === 200 && res.header.etag && options.cache) {
            options.cache.set(path, {
              value: result, eTag: res.header.etag, status: res.status,
              size: res.text.length
            });
          }
          if (res.header.link) {
            var match = /<(.+?)>;\s*rel="next"/.exec(res.header.link);
            if (match) {
              if (options.allPages) {
                req = superagent(options.method, match[1]);
                addHeaders(req, options);
                cachedItem = checkCache(req, options);
                req.end(onComplete);
                return;  // Don't resolve yet, more pages to come.
              } else {
                result.next = function() {
                  return self.request(match[1], options);
                };
              }
            }
          }
          resolve(result);
        }
      }
    });

    if (options.immutable && options.method === 'GET') {
      options.cache.set(path, {promise: requestPromise, size: 100});
    }
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
  }

  function checkCache(req, options) {
    var cachedItem = options.method === 'GET' && options.cache && options.cache.get(req.url);
    if (cachedItem && cachedItem.eTag) req.set('If-None-Match', cachedItem.eTag);
    return cachedItem;
  }

  return Hubkit;
});
