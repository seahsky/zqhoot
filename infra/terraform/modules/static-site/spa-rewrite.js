// CloudFront Function (cloudfront-js-2.0), viewer-request, default behaviour only.
// The app is a single-page app: /join, /host, /present and friends are client-side routes, so any
// path whose last segment has no file extension is served from /index.html.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);

  if (lastSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }

  return request;
}
