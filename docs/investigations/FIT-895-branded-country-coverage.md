# FIT-895 Branded Country Coverage Audit

Audited on 2026-08-02 against:

- the app's `SUPPORTED_BRANDED_FOOD_COUNTRY_CODES` on `everlastingcrown/calorie-tracker` `main`;
- the country tag mappings in `scripts/food-seed/source-parsers.ts`; and
- the published assets in verified release `food-seed-v2.1.0-20260730T105256Z`.

Open Food Facts defines the canonical South Korea taxonomy entry as `en:south-korea`.
Its search API reported 3,108 products for South Korea during the audit. FIT-895 maps that tag and
common aliases to ISO 3166-1 alpha-2 `KR`; the next pipeline release will therefore emit
`foods-kr.branded.json.gz` alongside the existing country assets.

## Coverage

| Country | Code | App picker | Verified v2.1 asset | Result |
| --- | --- | --- | --- | --- |
| Austria | AT | Yes | Yes | Covered |
| Australia | AU | Yes | Yes | Covered |
| Belgium | BE | Yes | Yes | Covered |
| Brazil | BR | Yes | Yes | Covered |
| Canada | CA | Yes | Yes | Covered |
| Denmark | DK | Yes | Yes | Covered |
| English (legacy pseudo-country) | EN | Yes | Yes | Covered |
| France | FR | Yes | Yes | Covered |
| Germany | DE | Yes | Yes | Covered |
| Hong Kong | HK | Yes | Yes | Covered |
| India | IN | Yes | Yes | Covered |
| Ireland | IE | Yes | Yes | Covered |
| Italy | IT | Yes | Yes | Covered |
| Japan | JP | Yes | Yes | Covered |
| Mexico | MX | Yes | Yes | Covered |
| Netherlands | NL | Yes | Yes | Covered |
| New Zealand | NZ | Yes | Yes | Covered |
| South Korea | KR | Follow-up required | Added by FIT-895 | Added |
| Spain | ES | Yes | Yes | Covered |
| Sweden | SE | Yes | Yes | Covered |
| Switzerland | CH | Yes | Yes | Covered |
| United Kingdom | GB | Yes | Yes | Covered |
| United States | US | Yes | Yes | Covered |

The audit found no missing data assets among the 22 countries already exposed by the app. The
`unknown` artifact is intentionally excluded because it is a fallback bucket, not a selectable
country. App-side KR picker support is tracked in [FIT-950](/FIT/issues/FIT-950) so the data and
application changes can follow their own repository review and release workflows.

## Validation

The pipeline regression fixture uses a real nutritionally complete South Korean Open Food Facts
record (`8801115111054`, Seoul Milk). It asserts that the build creates both
`foods-kr.branded.json` and its gzip counterpart, stamps `countryCode: "kr"`, and passes the same
schema, content, integrity, and count validation used for every existing country artifact.
