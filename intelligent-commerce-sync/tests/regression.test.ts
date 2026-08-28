import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJakmallHtml } from "../src/jakmall/parser.js";
import {
  normalizeToCanonical,
  normalizeStock,
  JakmallNormalizerError,
} from "../src/jakmall/normalizer.js";
import type { JakmallRawSkuItem, ParsedJakmallPage } from "../src/jakmall/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, "fixtures");

test("ACMIC CPD65 golden fixture end-to-end regression (Literal Observed Raw IDs, Prices & Stock)", () => {
  const html = fs.readFileSync(path.join(fixturesDir, "acmic.html"), "utf-8");
  const parsed = parseJakmallHtml(html);

  // 1. Basic properties
  assert.equal(parsed.spdt.id, "6970238281488");
  assert.equal(parsed.brand, "ACMIC");

  // Normalization to canonical
  const canonical = normalizeToCanonical(
    parsed,
    "https://www.jakmall.com/acmic-official-store/acmic-cpd65-gan-65w-super-fast-charging-65-w-charger-pd-power-adapter#5502951494118"
  );

  assert.equal(canonical.sourceProductId, "6970238281488");
  assert.equal(canonical.variants.length, 9, "ACMIC must resolve exactly 9 source SKUs");

  // Literal raw source values for ACMIC
  const expectedAcmic = [
    {
      id: "5502951494118",
      displaySku: "5502951494118",
      option: "CPD65 PRO Only",
      price: 379000,
      available: true,
      exact: true,
      quantity: 3,
      status: "limited",
    },
    {
      id: "7340637866967",
      displaySku: "7340637866967",
      option: "CPD65 PRO + Kabel",
      price: 449000,
      available: false,
      exact: true,
      quantity: 0,
      status: "out_of_stock",
    },
    {
      id: "9480799845218",
      displaySku: "9480799845218",
      option: "CPD65 LITE Only",
      price: 299000,
      available: false,
      exact: true,
      quantity: 0,
      status: "out_of_stock",
    },
    {
      id: "4395402255230",
      displaySku: "4395402255230",
      option: "DUO Mint Green",
      price: 399000,
      available: false,
      exact: true,
      quantity: 0,
      status: "out_of_stock",
    },
    {
      id: "4711519218246",
      displaySku: "4711519218246",
      option: "DUO Rose Pink",
      price: 399000,
      available: false,
      exact: true,
      quantity: 0,
      status: "out_of_stock",
    },
    {
      id: "7017009772176",
      displaySku: "7017009772176",
      option: "DUO Ice Blue",
      price: 399000,
      available: false,
      exact: true,
      quantity: 0,
      status: "out_of_stock",
    },
    {
      id: "5079585778025",
      displaySku: "5079585778025",
      option: "DUO Spring Lilac",
      price: 399000,
      available: false,
      exact: true,
      quantity: 0,
      status: "out_of_stock",
    },
    {
      id: "6470241162785",
      displaySku: "6470241162785",
      option: "DUO Black",
      price: 399000,
      available: false,
      exact: true,
      quantity: 0,
      status: "out_of_stock",
    },
    {
      id: "8543126559080",
      displaySku: "8543126559080",
      option: "DUO White",
      price: 399000,
      available: false,
      exact: true,
      quantity: 0,
      status: "out_of_stock",
    },
  ];

  for (const exp of expectedAcmic) {
    const v = canonical.variants.find((item) => item.sourceSkuId === exp.id);
    assert.ok(v, `Real source SKU ID ${exp.id} (${exp.option}) must exist in canonical output`);
    assert.equal(v.attributes["Lain-lain"], exp.option);
    assert.equal(v.displaySku, exp.displaySku);
    assert.equal(v.merchantSku, undefined, "sku is null in raw source");
    assert.equal(v.price.final, exp.price);
    assert.equal(v.weightGrams, 230);
    assert.equal(v.inventory.available, exp.available);
    assert.equal(v.inventory.exact, exp.exact);
    assert.equal(v.inventory.quantity, exp.quantity);
    assert.equal(v.inventory.status, exp.status);
    assert.equal(v.sourceSku, exp.id);
  }
});

test("MOMO CARGO golden fixture end-to-end regression (Literal Raw ID 7372731614335 & Price 119400)", () => {
  const html = fs.readFileSync(path.join(fixturesDir, "momo.html"), "utf-8");
  const parsed = parseJakmallHtml(html);

  assert.equal(parsed.spdt.id, "7372731614335");

  const canonical = normalizeToCanonical(
    parsed,
    "https://www.jakmall.com/shopping-mania/momo-celana-panjang-cargo-pria-tactical-waterproof-polyester-cotton-ap78#2715227285879"
  );

  assert.equal(canonical.sourceProductId, "7372731614335");
  assert.equal(canonical.variants.length, 1);
  const variant = canonical.variants[0];
  assert.ok(variant);

  // Literal raw values
  assert.equal(variant.sourceSkuId, "2715227285879");
  assert.equal(variant.merchantSku, "OMPKGKBK");
  assert.equal(variant.displaySku, "OMPKGKBK");
  assert.equal(variant.sourceSku, "2715227285879");
  assert.equal(variant.attributes["Ukuran"], "XL");
  assert.equal(variant.attributes["Warna"], "Hitam");
  assert.equal(variant.weightGrams, 800);
  assert.equal(variant.price.final, 119400);

  // Undisclosed quantity (available=true, exact=false, quantity=undefined)
  assert.equal(variant.inventory.available, true);
  assert.equal(variant.inventory.exact, false);
  assert.equal(variant.inventory.quantity, undefined);
  assert.equal(variant.inventory.status, "in_stock");
});

test("ASV RAINCOAT golden fixture end-to-end regression (Literal Raw ID 2389444540861 & 6 Combinations)", () => {
  const html = fs.readFileSync(path.join(fixturesDir, "asv.html"), "utf-8");
  const parsed = parseJakmallHtml(html);

  assert.equal(parsed.spdt.id, "2389444540861");

  const canonical = normalizeToCanonical(
    parsed,
    "https://www.jakmall.com/lstore/jas-hujan-asv-versi-1-kualitas-no1-rubber-press#3813346585186"
  );

  assert.equal(canonical.sourceProductId, "2389444540861");
  assert.equal(canonical.variants.length, 6, "ASV must resolve exactly 6 combinations");

  const expectedAsv = [
    { id: "3813346585186", size: "L", color: "Hitam" },
    { id: "6072330745027", size: "L", color: "Biru Tua" },
    { id: "6165317079560", size: "XL", color: "Hitam" },
    { id: "6162039043925", size: "XL", color: "Biru Tua" },
    { id: "3720859133975", size: "XXL", color: "Hitam" },
    { id: "8827576919834", size: "XXL", color: "Biru Tua" },
  ];

  for (const exp of expectedAsv) {
    const v = canonical.variants.find((item) => item.sourceSkuId === exp.id);
    assert.ok(v, `Real source SKU ID ${exp.id} (${exp.size} + ${exp.color}) must exist`);
    assert.equal(v.attributes["Ukuran"], exp.size);
    assert.equal(v.attributes["Warna"], exp.color);
    assert.equal(v.weightGrams, 1700);
    assert.equal(v.price.final, 190000);
    assert.equal(v.inventory.available, true);
    assert.equal(v.inventory.exact, false);
    assert.equal(v.inventory.quantity, undefined);
    assert.equal(v.preorder?.enabled, false);
    assert.equal(v.merchantSku, undefined);
    assert.equal(v.sourceSku, exp.id);
  }
});

test("Stock semantics strictly handles edge cases, missing data, and inconsistencies without conflation", () => {
  // Case 1: out of stock (confirmed 0)
  const oos: JakmallRawSkuItem = {
    id: "s1",
    in_stock: false,
    is_limited_stock: false,
    limited_stock: null,
  };
  const stock1 = normalizeStock(oos);
  assert.equal(stock1.available, false);
  assert.equal(stock1.exact, true);
  assert.equal(stock1.quantity, 0);
  assert.equal(stock1.status, "out_of_stock");

  // Case 2: limited exact stock
  const lim: JakmallRawSkuItem = {
    id: "s2",
    in_stock: true,
    is_limited_stock: true,
    limited_stock: 5,
  };
  const stock2 = normalizeStock(lim);
  assert.equal(stock2.available, true);
  assert.equal(stock2.exact, true);
  assert.equal(stock2.quantity, 5);
  assert.equal(stock2.status, "limited");

  // Case 3: in stock, unlimited/unknown exact
  const normalStock: JakmallRawSkuItem = {
    id: "s3",
    in_stock: true,
    is_limited_stock: false,
    limited_stock: null,
  };
  const stock3 = normalizeStock(normalStock);
  assert.equal(stock3.available, true);
  assert.equal(stock3.exact, false);
  assert.equal(stock3.quantity, undefined);
  assert.equal(stock3.status, "in_stock");

  // Inconsistent case: is_limited_stock === true BUT limited_stock === null
  const inconsistent: JakmallRawSkuItem = {
    id: "s4",
    in_stock: true,
    is_limited_stock: true,
    limited_stock: null,
  };
  const stock4 = normalizeStock(inconsistent);
  assert.equal(stock4.available, null, "Inconsistent limited stock must yield available = null");
  assert.equal(stock4.exact, false);
  assert.equal(stock4.quantity, undefined);
  assert.equal(stock4.status, "unknown");

  // Missing inventory (in_stock: undefined) -> available: null
  const missingStock: JakmallRawSkuItem = {
    id: "s5",
    in_stock: undefined,
  };
  const stock5 = normalizeStock(missingStock);
  assert.equal(stock5.available, null, "Missing inventory must yield available = null");
  assert.equal(stock5.exact, false);
  assert.equal(stock5.quantity, undefined);
  assert.equal(stock5.status, "unknown");
});

test("Price safety: missing, null, or zero price must never silently become 0", () => {
  const dummyParsed: ParsedJakmallPage = {
    title: "Bad Product",
    description: "Product with invalid price",
    brand: null,
    categoryPath: ["Demo"],
    specifications: {},
    spdt: {
      id: "prod-bad",
      sku: {
        "sku-missing-price": {
          id: "sku-missing-price",
          in_stock: true,
          is_limited_stock: false,
          limited_stock: null,
          price: {
            final: null,
          },
        },
      },
    },
  };

  assert.throws(
    () => normalizeToCanonical(dummyParsed, "https://www.jakmall.com/demo/bad"),
    (err: unknown) => err instanceof JakmallNormalizerError && err.code === "MISSING_PRICE"
  );

  dummyParsed.spdt.sku["sku-missing-price"]!.price!.final = 0;
  assert.throws(
    () => normalizeToCanonical(dummyParsed, "https://www.jakmall.com/demo/bad"),
    (err: unknown) => err instanceof JakmallNormalizerError && err.code === "INVALID_PRICE"
  );
});
