import test from "node:test";
import assert from "node:assert/strict";
import { validateJakmallUrl, JakmallClientError } from "../src/jakmall/client.js";

test("validateJakmallUrl allows valid JakMall URLs", () => {
  const url1 = validateJakmallUrl("https://www.jakmall.com/baseus/earphone-tws");
  assert.equal(url1.hostname, "www.jakmall.com");

  const url2 = validateJakmallUrl("https://jakmall.com/item/12345");
  assert.equal(url2.hostname, "jakmall.com");
});

test("validateJakmallUrl blocks SSRF attempts (localhost, internal IP, private hostnames)", () => {
  assert.throws(
    () => validateJakmallUrl("http://localhost:3000/admin"),
    (err: unknown) => err instanceof JakmallClientError && err.code === "SSRF_BLOCKED"
  );

  assert.throws(
    () => validateJakmallUrl("http://127.0.0.1:8080/internal"),
    (err: unknown) => err instanceof JakmallClientError && err.code === "SSRF_BLOCKED"
  );

  assert.throws(
    () => validateJakmallUrl("http://169.254.169.254/latest/meta-data"),
    (err: unknown) => err instanceof JakmallClientError && err.code === "SSRF_BLOCKED"
  );

  assert.throws(
    () => validateJakmallUrl("ftp://www.jakmall.com/file"),
    (err: unknown) => err instanceof JakmallClientError && err.code === "SSRF_BLOCKED"
  );

  assert.throws(
    () => validateJakmallUrl("file:///etc/passwd"),
    (err: unknown) => err instanceof JakmallClientError && err.code === "SSRF_BLOCKED"
  );
});
