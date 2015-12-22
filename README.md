hubkit
======

A simple GitHub API library for JavaScript that works in both NodeJS and the browser.  Features:
* Takes a request-level approach that naturally covers the entire GitHub v3 API.
* All requests return promises.  (You may need to add a polyfill in the browser, depending on your target platforms.  The Node package includes a polyfill in case you're not running with `--harmony`.)
* Responses are (optionally) cached (segregated by user identity), and requests are conditional to save on bandwidth and request quota.
Inspired by [simple-github](https://github.com/tobie/simple-github), [octo](https://github.com/Caged/octo), and [octokit](https://github.com/philschatz/octokit.js).

To enable caching, make sure that [LRUCache](https://github.com/isaacs/node-lru-cache) is
loaded. It's installed by default for Node, but in the browser you need to load `lru-cache.js`
(perhaps from the [Bower-compatible variant](https://github.com/jmendiara/serialized-lru-cache)).  Or
you can pass any other cache instance as an option to the constructor, as long as it has `get`,
`set`, and `del` methods.  Also, since v0.2, if the cache is enabled it respects `Cache-Control` headers on the response (that GitHub currently seems to set to 1 minute for all requests), and will return a potentially stale value from the cache unless you specify `{fresh: true}`.

A simple example:

```javascript
var gh = new Hubkit({
  token: '123456890ABCDEF',
  owner: 'pkaminski',
  repo: 'hubkit'
});
gh.request('GET /repos/:owner/:repo/commits').then(console.log);
gh.request('GET /repos/:owner/:repo/git/commits/:sha', {sha: '09876abc'}).then(console.log);
gh.request('POST /repose/{owner}/{repo}/pulls', {body: {title: 'foo', head: 'bar', base: 'master'}});
```

You issue requests exactly as documented in [GitHub's API](https://developer.github.com/v3/).  Path
segments of the form `:foo` or `{foo}` are interpolated from the options object passed as the second
argument and defaulting to the options object passed to the constructor.  The method can be
specified either together with the path, or as a `{method: 'GET'}` option (the inline one takes
precedence, and `GET` is the default if nothing else is found).

There are two ways to authenticate:  either pass a `token` to the options, or both a `username` and
`password`.  Unauthenticated requests are fine too, of course.

Every call returns a `Promise`, which you might need to polyfill if your target environment doesn't
support it natively.  You can then use the standard `then` API to specify both success and failure
callbacks, or in Node it integrates nicely with [`co`](https://github.com/visionmedia/co), so you
can do something like:

```javascript
co(function*() {
  var commits = yield gh.request('GET /repose/:owner/:repo/commits');
})();
```

The returned values are exactly as documented in the GitHub API, except that requests with option
`{boolean: true}` will return `true` or `false` instead (sorry, no way to automate it).  Note that
for paged responses, all pages will be concatenated together into the return value by default (see
below).

After every request, you can access `rateLimit` and `rateLimitRemaining` (or `searchRateLimit` and
`searchRateLimitRemaining` if it's a search request) for the latest information on your GitHub
quotas, and `oAuthScopes` to see what scopes your authorization entitles you to, on your `metadata`
object (see below) or on `Hubkit` if you didn't set one.

Valid options to pass (to the constructor or to each request), or to set on `Hubkit.defaults`,
include:
* `token`: String token to use for authentication; takes precedence over username and password.
* `username` and `password`: For basic authentication.
* `userAgent`: The user-agent to present in requests.  Uses the browser's user agent, or `Hubkit`
in NodeJS.
* `host`: The hostname to prepend to all request paths; defaults to `https://api.github.com`.
* `timeout`: The timeout in milliseconds to apply to the request; none by default.  If the timeout is reached, the request will abort with an error that will have a `timeout` attribute set to the value you provided.
* `agent`: On NodeJS only, the agent to use for the HTTP connection, e.g. to do connection pooling.  You may want to consider using [agentkeepalive](https://www.npmjs.com/package/agentkeepalive) if you're making a lot of requests.
* `cache`: An object with `get`, `set`, and `del` methods to be used as a cache for responses.  The
objects inserted into the cache will be of the form
`{value: {...}, eTag: 'abc123', status: 200, size: 1763}`.
You can use the (approximate) `size` field to help your cache determine when to evict items, but note that it tends to underestimate the actual size size of the object by 3-4x.  The
default cache is set to hold ~10MB of the measured bytes amount (so ~30-40MB of actual memory usage).
* `fresh`: If true, force a request to be issued to the server even if a cache is in use and an unexpired value available.  This is different from turning off the cache for the request since it can still make use of ETags and get a cheap 304 response in return.
* `maxItemSizeRatio`: The maximum ratio of the size of any single item to the size of the cache, to avoid blowing away the entire cache with one huge item.  The default is set to 0.1, limiting each item to at most 1/10th the max size of the cache.
* `stats`: Reports the cache hit rate via `hitRate` (number of items hit / total attempted) and `hitSizeRate` (total size of items hit / total attempted) attributes.  You can `reset()` the stats to start counting from scratch again.  A default instance is set on `Hubkit.defaults` but you can also assign a `new Hubkit.Stats()` to a `Hubkit` instance if you prefer.
* `immutable`: If true, indicates that the return value for this call is immutable, so if it's available in the cache it can be reused without sending a request to GitHub to check freshness.
* `method`: The HTTP method to use for the request.
* `media`: A GitHub-specific [media type](https://developer.github.com/v3/media/) for the response
content.  Valid values are:
  * for comment bodies: `raw+json` (default), `text+json`, `html+json`, `full+json`
  * for blobs: `json` (default), `raw`
  * for commits, etc.: `diff`, `patch`
* `body`: The contents of the request to send, typically a JSON-friendly object.
* `responseType`: The XHR2 response type if you want to receive raw binary data; one of `text`, `arraybuffer`, `blob`, or `document`.  Only useful when fetching file blobs.
* `perPage`: The number of items to return per page of response.  Defaults to 100.
* `allPages`: Whether to automatically fetch all pages by following the `next` links and concatenate
the results before returning them.  Defaults to true.  If set to false and a result has more pages,
you'll find a `next()` function on the result that you can call to get a promise with the next page
of items.
* `boolean`: If true, interprets a 404 as false and a 20x as true.
* `metadata`: The object on which to set metadata found in the response headers.  Defaults to `Hubkit`.
* `ifNotFound`: A value to return instead of throwing an exception when the request results in a 404.
* `ifGone`: A value to return instead of throwing an exception when the request results in a 410.
* `onError`: A function to be called when an error occurs, either in the request itself or an
unexpected 4xx or 5xx response.  If it's an error response, the error object will have `status`,
`method`, `path`, and `response` attributes.  If the function returns `undefined`, the promise will
be rejected as usual (or the request retried in some special cases, like socket hang ups and abuse quota 403s), if it returns `Hubkit.RETRY` the request will be retried, if it returns `Hubkit.DONT_RETRY` the promise will always be rejected, and if returns any other value the promise will be resolved with the returned value.  If multiple onError handlers are assigned (e.g., in default options and in per-request options), they will all be executed, and the first non-undefined value from the most specific handler will be used.
* `maxTries`: The maximum number of times that a request will be tried (including the original call) if `onError` keeps returning `Hubkit.RETRY`.
