# FIT-783 AU portion-serving audit

## Finding

The `food-seed-daily-latest` AU branded artifact generated at
`2026-07-13T08:42:13.800Z` contains 58,203 foods. Of those, 1,160 Open Food
Facts rows have a numeric `portion` label but were emitted with
`servingUnit: "ml"` and identical `servingQuantity` and `servingSizeG` values.
This makes a labelled portion behave like one millilitre.

The complete affected-record list is in
[`FIT-783-au-portion-serving-audit.json`](./FIT-783-au-portion-serving-audit.json).
It includes the reported Farmdale milk (`off-4061459224641`) and all other AU
branded records with the same emitted-data shape.

## Cause and correction

The shared serving parser recognized `serving` as a discrete unit but did not
recognize `portion`. For a label such as `1 portion (250 ml)`, it skipped the
leading text and matched the parenthesized `250 ml`, producing 1 ml as the unit
weight.

The parser now normalizes `portion` and `portions` to the existing `serving`
unit. The same label therefore emits:

```json
{
  "servingSizeG": 250,
  "servingQuantity": 1,
  "servingUnit": "serving",
  "servingWeightsG": { "serving": 250 }
}
```

For the Farmdale milk, one selected portion now evaluates to 87 kcal, 8 g
protein, 12 g carbohydrate, and 0.3 g fat. The parser-level correction applies
to all affected rows when the food seed is rebuilt from the Open Food Facts
input; no runtime or barcode-specific override is required.

## Reproducing the audit

Download `foods-au.branded.json` from the `food-seed-daily-latest` GitHub
release, then select Open Food Facts records whose description begins with a
numeric portion and whose emitted ml quantity equals the serving weight. The
checked-in JSON is retained as the reviewable audit evidence for the release
that exposed this bug.
