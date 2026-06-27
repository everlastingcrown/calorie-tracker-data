# FIT-526 Open Food Facts AU Missing Calories Investigation

## Summary

Barcode `9310432001423` (`Udon noodles`, Obento) is parser-compatible with the
current Open Food Facts product response and should not be rejected as `missing
calories` by the current pipeline.

The live Open Food Facts API response checked on 2026-06-27 includes all energy
fields the importer expects:

- `energy-kcal_100g`: `138.623326959847`
- `energy-kcal`: `138.623326959847`
- `energy-kj_100g`: `557.1`
- `energy_100g`: `557.1`

The current importer reads kcal first and falls back to kJ conversion, so this
row emits a staging record rather than a QA rejection.

## Evidence

- Open Food Facts product API:
  `https://world.openfoodfacts.org/api/v2/product/9310432001423.json`
- Product `last_modified_t`: `1780786880` (`2026-06-06T23:01:20.000Z`)
- Pinned JSONL export in `inputs/manifest.json`: `2026-06-17`, S3 object
  `versionId=tOtgZga7slFLMXorQgrfzYPUSz.7VmsE`
- Pinned export object size: `12,295,458,033` compressed bytes
- Parser calorie logic added in commit `297363b` reads:
  `energy-kcal_100g`, `energy-kcal`, then `energy-kj_100g` / `energy_100g`
- Added regression fixture:
  `parseOpenFoodFactsDirectory accepts Obento udon Open Food Facts energy fields`

## Root Cause Assessment

No Open Food Facts API response format break was found for this product. The
current response still exposes `nutriments` as an object with the established
energy keys used by this repository.

The most likely explanations for the historical QA rejection are:

1. The QA artifact was generated from a stale or older Open Food Facts row that
   did not include usable energy fields at that time.
2. The QA artifact predates the importer calorie fallback added in `297363b`.
3. The pinned JSONL row differs from the live product API despite the product
   timestamp predating the pinned export.

The third case could only be fully ruled out by scanning the 12.3 GB compressed
pinned export. The inputs are not present in this worktree, and a full export
download was not performed for this investigation.

## Batch Impact

A bounded current-AU sample was checked through the Open Food Facts search API:

- Query: first 50 products tagged with Australia
- Products returned: 50
- Parser-compatible calorie fields present: 50
- Missing parser-compatible calorie fields: 0
- Serving-only calorie cases: 0

This sample did not show evidence of a broad response-format change affecting
Australian products.

## Fix Recommendation

No production parser change is recommended from this investigation.

Recommended next operational step: regenerate the food-seed outputs from the
current pinned inputs and inspect `generated/food-seed/foods.qa.json` for
barcode `9310432001423`. If it is still rejected, inspect the exact pinned JSONL
row for that barcode; if it is not rejected, treat the prior QA entry as stale.
