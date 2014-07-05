if (typeof require !== 'undefined') {
  if (typeof superagent === 'undefined') superagent = require('superagent');
  if (typeof LRUCache === 'undefined') {
    try {
      LRUCache = require('lru-cache');
    } catch(e) {
      // ignore, not actually required
    }
  }
}

(function() {
  'use strict';

  var cache = typeof LRUCache === 'undefined' ? null :
    new LRUCache({max: 500000, length: function(item) {return item.size;}});

  var Hubkit = function(options) {
    defaults(options, {
      method: 'get', host: 'https://api.github.com', perPage: 100, allPages: true, cache: cache
    });
    // NodeJS doesn't set a userAgent by default but GitHub requires one.
    if (typeof require !== 'undefined' && !options.userAgent) options.userAgent = 'Hubkit';
    this.defaultOptions = options;
  };

  if (typeof module === 'undefined') {
    window.Hubkit = Hubkit;
  } else {
    module.exports = Hubkit;
  }

  Hubkit.prototype.request = function(path, options) {
    var self = this;
    options = options || {};
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
        } else if (res.status === 304) {
          resolve(cachedItem.value);
        } else if (!(res.ok || res.notFound && res.body && res.body.message === 'Not Found')) {
          reject(new Error('' + res.status + ': ' + (res.body && res.body.message), res.body));
        } else {
          if (!res.body && res.text && /\bformat=json\b/.test(res.header['x-github-media-type'])) {
            res.body = JSON.parse(res.text);
          }
          if (res.body && Array.isArray(res.body)) {
            // Append to current result in case we're paging through.
            result.push.apply(result, res.body);
          } else {
            result = res.noContent ? true : (res.notFound ? false : (res.body || res.text));
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
      originalPath = path = a[1];
    }
    options.method = options.method.toUpperCase();
    path = path.replace(/:([a-z-_]+)|\{(.+?)\}/gi, function(match, v1, v2) {
      var v = (v1 || v2);
      var parts = v.split('.');
      var value = options;
      for (var i = 0; i < parts.length; i++) {
        if (!(parts[i] in value)) {
          throw new Error('Options missing variable "' + v + '" for path "' + originalPath + '"');
        }
        value = value[parts[i]];
      }
      return value;
    });
    if (!/^http/.test(path)) path = options.host + path;
    return path;
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
    // Pin cached value here, in case it gets evicted during the request
    var cachedItem = options.method === 'get' && options.cache && options.cache.get(req.url);
    if (cachedItem) req.set('If-None-Match', cachedItem.eTag);
    return cachedItem;
  }
})();
