import test from "node:test";
import assert from "node:assert/strict";
import {
  extractBalancedObject,
  safeParseJsObject,
  parseJakmallHtml,
  JakmallParserError,
} from "../src/jakmall/parser.js";

test("extractBalancedObject parses balanced object with nested braces and strings", () => {
  const script = `
    var other = { x: 1 };
    var spdt = {
      id: "prod-123",
      name: "Test {Nested} \\"Object\\"",
      nested: { a: 1, b: [2, 3] }
    };
    var next = 42;
  `;
  const result = extractBalancedObject(script, "spdt");
  assert.ok(result.startsWith("{"));
  assert.ok(result.endsWith("}"));
  const parsed = safeParseJsObject(result) as Record<string, unknown>;
  assert.equal(parsed["id"], "prod-123");
  assert.equal(parsed["name"], 'Test {Nested} "Object"');
});

test("parseJakmallHtml extracts product with embedded spdt", () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>JakMall - Baseus Earphone TWS</title>
        <meta property="og:title" content="Baseus Encok True Wireless Earphones WM01" />
        <meta property="product:brand" content="Baseus" />
      </head>
      <body>
        <div class="breadcrumb">
          <a href="/category/audio">Audio</a>
          <a href="/category/earphone">Earphone</a>
        </div>
        <h1 class="product-title">Baseus Encok True Wireless Earphones WM01</h1>
        <div class="product-description">
          <p>Super bass wireless earphone with Bluetooth 5.0</p>
          <script>console.log('malicious');</script>
        </div>
        <script>
          var spdt = {
            id: "10987",
            url: "https://www.jakmall.com/baseus-store/baseus-encok-true-wireless-earphones-wm01",
            sku: {
              "SKU-BLK": {
                sku: "SKU-BLK",
                weight: 150,
                in_stock: true,
                is_limited_stock: true,
                limited_stock: 5,
                price: { final: 189000, normal: 250000, list: 300000 },
                images: [{ detail: "https://img.jakmall.com/wm01-black.jpg" }]
              },
              "SKU-WHT": {
                sku: "SKU-WHT",
                weight: 150,
                in_stock: true,
                is_limited_stock: false,
                limited_stock: null,
                price: { final: 189000 },
                images: [{ detail: "https://img.jakmall.com/wm01-white.jpg" }]
              }
            },
            store: { id: "store-99", name: "Baseus Official Store" }
          };
        </script>
      </body>
    </html>
  `;

  const parsed = parseJakmallHtml(html);
  assert.equal(parsed.title, "Baseus Encok True Wireless Earphones WM01");
  assert.equal(parsed.brand, "Baseus");
  assert.deepEqual(parsed.categoryPath, ["Audio", "Earphone"]);
  assert.equal(parsed.spdt.id, "10987");
  assert.equal(Object.keys(parsed.spdt.sku).length, 2);
  assert.equal(parsed.description.includes("malicious"), false);
});

test("parseJakmallHtml falls back to JSON-LD when spdt is absent", () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Fallback Product</title>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "Generic Product",
            "sku": "GEN-01",
            "offers": {
              "@type": "Offer",
              "price": 50000,
              "availability": "https://schema.org/InStock"
            }
          }
        </script>
      </head>
      <body>
        <h1 class="product-title">Generic Product</h1>
        <div class="product-description">Fallback description</div>
      </body>
    </html>
  `;

  const parsed = parseJakmallHtml(html);
  assert.equal(parsed.title, "Generic Product");
  assert.equal(parsed.spdt.id, "GEN-01");
  assert.equal(parsed.spdt.sku["GEN-01"]?.price?.final, 50000);
});

test("parseJakmallHtml handles full URI @type http://schema.org/Product and namespaced properties", () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Namespaced Product</title>
        <script type="application/ld+json">
          {
            "@context": "http://schema.org",
            "@type": "http://schema.org/Product",
            "http://schema.org/name": "Namespaced Earphone",
            "http://schema.org/sku": "NS-999",
            "http://schema.org/brand": {
              "@type": "http://schema.org/Brand",
              "http://schema.org/name": "NamespacedBrand"
            },
            "http://schema.org/weight": {
              "@type": "http://schema.org/QuantitativeValue",
              "http://schema.org/value": 350
            },
            "http://schema.org/offers": {
              "@type": "http://schema.org/Offer",
              "http://schema.org/price": 125000,
              "http://schema.org/availability": "http://schema.org/InStock"
            }
          }
        </script>
      </head>
      <body>
        <h1 class="product-title">Namespaced Earphone</h1>
      </body>
    </html>
  `;

  const parsed = parseJakmallHtml(html);
  assert.equal(parsed.title, "Namespaced Earphone");
  assert.equal(parsed.brand, "NamespacedBrand");
  assert.equal(parsed.spdt.id, "NS-999");
  assert.equal(parsed.spdt.sku["NS-999"]?.price?.final, 125000);
  assert.equal(parsed.spdt.sku["NS-999"]?.in_stock, true);
  assert.equal(parsed.spdt.sku["NS-999"]?.weight, 350);
});

test("parseJakmallHtml handles AggregateOffer with lowPrice", () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Aggregate Offer Product</title>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "Aggregate Product",
            "sku": "AGG-01",
            "offers": {
              "@type": "AggregateOffer",
              "lowPrice": 85000,
              "highPrice": 120000,
              "offerCount": 2,
              "availability": "https://schema.org/InStock"
            }
          }
        </script>
      </head>
      <body>
        <h1 class="product-title">Aggregate Product</h1>
      </body>
    </html>
  `;

  const parsed = parseJakmallHtml(html);
  assert.equal(parsed.spdt.id, "AGG-01");
  assert.equal(parsed.spdt.sku["AGG-01"]?.price?.final, 85000);
  assert.equal(parsed.spdt.sku["AGG-01"]?.in_stock, true);
});

test("parseJakmallHtml handles AggregateOffer with nested offers[] array", () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Nested Offers Product</title>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "Nested Offers Product",
            "productID": "NEST-01",
            "offers": {
              "@type": "AggregateOffer",
              "offers": [
                {
                  "@type": "Offer",
                  "price": 95000,
                  "availability": "https://schema.org/InStock"
                }
              ]
            }
          }
        </script>
      </head>
      <body>
        <h1 class="product-title">Nested Offers Product</h1>
      </body>
    </html>
  `;

  const parsed = parseJakmallHtml(html);
  assert.equal(parsed.spdt.id, "NEST-01");
  assert.equal(parsed.spdt.sku["NEST-01"]?.price?.final, 95000);
  assert.equal(parsed.spdt.sku["NEST-01"]?.in_stock, true);
});

test("parseJakmallHtml rejects JSON-LD missing or non-positive price", () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Zero Price Product</title>
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": "Free Product",
            "sku": "ZERO-01",
            "offers": {
              "@type": "Offer",
              "price": 0
            }
          }
        </script>
      </head>
      <body>
        <h1 class="product-title">Free Product</h1>
      </body>
    </html>
  `;

  assert.throws(
    () => parseJakmallHtml(html),
    (err: unknown) => err instanceof JakmallParserError && err.code === "EXTRACTION_FAILED"
  );
});

test("parseJakmallHtml throws on missing spdt and missing JSON-LD", () => {
  const html = `<html><body><h1>Product</h1></body></html>`;
  assert.throws(
    () => parseJakmallHtml(html),
    (err: unknown) => err instanceof JakmallParserError && err.code === "EXTRACTION_FAILED"
  );
});

test("parseJakmallHtml throws on invalid spdt structure", () => {
  const html = `
    <html>
      <head><title>Product</title></head>
      <body>
        <h1>Invalid Product</h1>
        <script>
          var spdt = {
            // Missing required fields 'id' and 'sku'
            name: "Broken"
          };
        </script>
      </body>
    </html>
  `;
  assert.throws(
    () => parseJakmallHtml(html),
    (err: unknown) => err instanceof JakmallParserError && (err.code === "EXTRACTION_VALIDATION_FAILED" || err.code === "EXTRACTION_FAILED")
  );
});
