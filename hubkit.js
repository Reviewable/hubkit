(function() {
  'use strict';

  if (!superagent) superagent = require('superagent');
  if (require && !LRUCache) LRUCache = require('lru-cache');
  var cache = LRUCache ?
    new LRUCache({max: 500000, length: function(item) {return item.size;}}) : null;

  var Hubkit = function(options) {
    defaults(options, {
      method: 'get', host: 'https://api.github.com', perPage: 100, allPages: true, cache: cache
    });
    if (require && !options.userAgent) options.userAgent = 'Hubkit';
    this.defaultOptions = options;
  };

  Hubkit.prototype.request = function(path, options) {
    var self = this;
    defaults(options, this.defaultOptions);
    path = interpolatePath(path, options);
    var req = superagent(options.method, path);
    addHeaders(req, options);
    var cachedItem = checkCache(req, options);

    return new Promise(function(resolve, reject) {
      var result = [];

      function onComplete(error, res) {
        Hubkit.rateLimit = res && res.header['x-ratelimit-limit'];
        Hubkit.rateLimitRemaining = res && res.header['x-ratelimit-remaining'];
        if (error) {
          reject(error);
        } else if (!(res.ok || res.notFound && res.body && res.body.message === 'Not Found')) {
          reject(new Error('' + res.status + ': ' + res.body && res.body.message, res.body));
        } else if (res.status === 304) {
          resolve(cachedItem.value);
        } else {
          if (res.body && Array.isArray(res.body)) {
            // Append to current result in case we're paging through.
            result.push.apply(result, res.body);
          } else {
            result = res.noContent ? true : (res.notFound ? false : res.body);
          }
          if (res.status === 200 && res.header.etag && options.cache) {
            options.cache.set(path, {
              value: result, eTag: res.header.etag, status: res.status,
              size: res.header['content-length']
            });
          }
          if (res.header.link) {
            var match = /<(.+?)>;\s*rel="next"/.exec(res.header.link);
            if (match) {
              if (options.allPages) {
                req.url = match[1];
                req.end(onComplete);
                return;  // Don't resolve yet, more pages to come.
              } else {
                result.next = function() {
                  return self.request(match[1]);
                };
              }
            }
          }
          resolve(result);
        }
      }

      req.send(options.body).end(onComplete);
    });

  };

  function defaults(o1, o2) {
    for (var key in o2) {
      if (!(key in o1)) o1[key] = o2[key];
    }
    return o1;
  }

  function interpolatePath(path, options) {
    var originalPath = path;
    var a = path.split(' ');
    if (a.length == 2) {
      options.method = a[0];
      path = a[1];
    }
    options.method = options.method.toLowerCase();
    path = path.replace(/:([a-z-_]+)|\{([a-z-_]+)\}/gi, function(match, v1, v2) {
      var v = v1 || v2;
      if (!(v in options)) {
        throw new Error('Options missing variable "' + v + '" for path "' + originalPath + '"');
      }
      return options[v];
    });
    if (!/^http/.test(path)) path = options.host + path;
    return path;
  }

  function addHeaders(req, options) {
    if (options.token) req.set('Authorization', 'token ' + token);
    if (!options.token && options.username && options.password) {
      req.auth(options.username, options.password);
    }
    if (options.userAgent) req.set('User-Agent', options.userAgent);
    req.query({per_page: options.perPage});
  }

  function checkCache(req, options) {
    // Pin cached value here, in case it gets evicted during the request
    var cachedItem = options.method === 'get' && options.cache && options.cache.get(req.url);
    if (cachedItem) req.set('If-None-Match', cachedItem.eTag);
    return cachedItem;
  }
})();
