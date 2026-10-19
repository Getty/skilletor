// Regenerates t/data/url-oracle.json: what Node's new URL() gives for each input (protocol,
// hostname, port, pathname) or that it throws. Run from perl/:
//   node maint/oracle-url.mjs > t/data/url-oracle.json
const inputs = [
  "https://example.com", "https://example.com/", "https://Example.COM/a/../b/Repo.git", "https://example.com/ü/skills",
  "https://example.com/a b/c", "https://example.com:8080/x/y", "https://example.com:443/x", "https://example.com:99999/x",
  "https://example.com:/x", "https://example.com:8a/x", "https://user:pw@example.com/team/repo.git?x=1#frag",
  "ssh://git@Example.com/Team/Repo", "ssh://git@example.com:22/a/./b/../c.git", "git://host/a%2e%2e/b",
  "file:///srv/repos/My.Repo.git", "file://localhost/srv/x", "file://Host/x", "https://exämple.com/x.tar.gz",
  "https://EXAMPLE.com/S.TAR.GZ", "https://example.com/%7Euser/repo", "https://example.com/a\\b\\c", "ssh://host/a\\b",
  "https://[::1]/x/y", "https://[::1]:8080/x", "https://127.0.0.1/a.tgz", "https://0x7f.1/a.tgz", "https://0177.0.0.1/",
  "https://1.2.3/", "https://4294967295/", "https://4294967296/", "https://1.256.1.1/", "https://example.1/",
  "https://ex%41mple.com/a.tgz", "https://exa mple.com/a.tgz", "https://example.com/.", "https://example.com/..",
  "https://example.com/a/.", "https://example.com/a/%2E%2e/b", "https://example.com/a?b/c", "https://example.com/a#b/c",
  "https://example.com/C%C3%BC/x", "https://example.com/\u0001x/y", "https://", "https:///x", "https:example.com/x",
  "ssh://", "ssh://h", "ssh://h/", "ssh://a b/c", "ssh://ho%st/x", "ssh://hÖst/x", "codecommit://profile@my-repo",
  "s3://bucket/path/skills.tar.gz", "https://a:b:c/x", "https://münchen.de/", "https://BÜCHER.example/",
  "https://example.com./x", "https://a..b/", "https://xn--nxasmq6b.com/", "https://日本.jp/x", "https://ß.de/",
  "  https://example.com/x  ", "https://exa\tmple.com/x", "http://localhost:3000/a.tgz", "https://example.com/{a}`b`<c>\"d\"",
  "https://example.com/a%zz", "ssh://user@[::1]:2222/repo", "git+ssh://host/x/y.git", "HTTP://EXAMPLE.COM/",
];
const out = inputs.map((input) => {
  try {
    const u = new URL(input);
    return { input, protocol: u.protocol, hostname: u.hostname, port: u.port, pathname: u.pathname };
  } catch (e) {
    return { input, error: e.message };
  }
});
console.log(JSON.stringify(out, null, 1));
