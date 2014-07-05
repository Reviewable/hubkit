hubkit
======

A simple GitHub API library for JavaScript that works in both NodeJS and the browser.  Features:
* Takes a request-level approach that naturally covers the entire GitHub v3 API.
* All requests return promises.  (You need to include a promise polyfill or run node with --harmony.)
* Responses are (optionally) cached, and requests are conditional to save on bandwidth and request quota.
Inspired by [simple-github](https://github.com/tobie/simple-github), [octo](https://github.com/Caged/octo), and [octokit](https://github.com/philschatz/octokit.js).

To enable caching, make sure that [LRUCache](https://github.com/isaacs/node-lru-cache) is loaded.
Either `npm install lru-cache --save` (for NodeJS), or load `lru-cache.js` into the browser.  Or you
can pass any other cache instance as an option to the constructor, as long as it has `get` and `set`
methods.

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

The returned values are exactly as documented in the GitHub API, except that requests with a boolean
response will return `true` or `false` instead.  Note that for paged responses, all pages will be
concatenated together into the return value by default (see below).

After every request, you can access `Hubkit.rateLimit` and `Hubkit.rateLimitRemaining` for the
latest information on your GitHub quotas.

Valid options to pass (to the constructor or to each request) include:
* `token`: String token to use for authentication; takes precedence over username and password.
* `username` and `password`: For basic authentication.
* `userAgent`: The user-agent to present in requests.  Uses the browser's user agent, or `Hubkit`
in NodeJS.
* `host`: The hostname to prepend to all request paths; defaults to `https://api.github.com`.
* `cache`: An object with `get` and `set` methods to be used as a cache for responses.  The objects
inserted into the cache will be of the form `{value: {...}, eTag: 'abc123', status: 200, size: 1763}`.
You can use the (approximate) `size` field to help your cache determine when to evict items.  The
default cache is set to hold ~500K.
* `method`: The HTTP method to use for the request.
* `body`: The contents of the request to send, typically a JSON-friendly object.
* `perPage`: The number of items to return per page of response.  Defaults to 100.
* `allPages`: Whether to automatically fetch all pages by following the `next` links and concatenate
the results before returning them.  Defaults to true.  If set to false and a result has more pages,
you'll find a `next()` function on the result that you can call to get a promise with the next page
of items.
