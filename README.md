# BCD to Cable Schedule

Turns block cable diagram (BCD) PDFs into a filled-in cable schedule in the company Excel template.

You drop the BCD PDFs for one schedule (usually 4 or 5 sheets) into a web page. The page:

1. reads every cable label on every sheet (e.g. `L25NA1001 (B2)` with `4c x 2.5mm² XLPE/SWA BS5467`)
2. follows each cable line on the drawing to find what is at each end (a board way, a JB, a pump, another drawing)
3. merges cables that appear on more than one sheet (e.g. the MDB feeder that also appears as the LCP incomer)
4. checks the result and marks anything it could not confirm
5. writes the schedule into the template and offers it as an `.xlsx` download

Everything runs in the user's browser. **The drawings are never uploaded**, unless the user switches on the optional AI cross-check.

---

## Using it

Open the page, drag in the PDFs, fill in the four header fields, check the amber rows, then click **Download Excel schedule**.

| Button | What you get |
|---|---|
| Download Excel schedule | The cable schedule in the company template, ready to issue after checking |
| Review list (.csv) | One line per thing to check: cable ref, ends, and the reason |
| Data (.json) | Everything the tool read from each drawing, for traceability or other tools |

Any cell in the table can be corrected before downloading.

### Ways to give it to other people

| Option | How | Notes |
|---|---|---|
| Web link | GitHub Pages publishes `docs/index.html` | `https://<username>.github.io/<repo-name>/`, open to anyone, no account needed |
| Single HTML file | Send `docs/index.html` by email or Teams | Double-click to open in Chrome or Edge. Needs internet to load the two libraries from cdnjs |
| Company intranet | Copy the HTML file to any internal web server or SharePoint site that serves HTML | No server code needed |

---

## Rules it follows

| Column | Where it comes from |
|---|---|
| Cable ref | The label on the drawing, exactly as drawn, including `LC` prefixes and `-1` suffixes |
| Source / Destination | Traced from the drawing (see below), written as full names |
| Cable type | Text beside the cable, e.g. `XLPE/SWA BS5467`, `6181-Y`, `VENDOR CABLE`, `SUBCAB` |
| No. of cores & size | Text beside the cable, normalised to `4c x 2.5mm2`, `1PR x 0.75mm2`, `3 x 1c x 10mm2` |
| Voltage | From the band: **B1 → 24V, B2 → 400V, B1&B2 → 400V** |
| Voltage band | From the label, e.g. `(B2)`. If missing, assumed from the prefix (L/LC → B2, CE → B1) and marked for checking |
| Design length, CPC type, Installation method, Comments | Left blank |

**Names.** Board names come from the REFERENCE row of the header strip (`Detention Tank LCP - Form 2a` → `Detention Tank LCP`). Equipment names come from the box text (`JB P01`) or the label under the symbol (`STORM RETURN PUMP NO.1` → `Storm Return Pump No.1`). Power ratings like `5.5 kW` are dropped. Acronyms stay in capitals (`JB`, `LCP`, `CSO`, `EDM`, `SPD` …). Abbreviations listed in `src/rules.js` are written out (`EB` → `Earth Bar`).

**Other drawings.** `FROM DRAWING 80065564-…-00005` is matched to the uploaded sheet whose title block has that client drawing number, and replaced with that sheet's board name. A note such as `(TO EDM CONTROLLER)` names the equipment on the other sheet.

**Direction.** Default is *Source = supply end* (board → JB → equipment). The page has a setting to reverse it. The supply end is decided in this order:
1. `FROM DRAWING` / `TO DRAWING` wording, when every sheet showing the cable agrees
2. A board way called `MAINS INCOMER` or `LINK FROM …` receives the cable
3. Ranking: DNO / board way → other drawing → box (JB, isolator, controller, outstation) → field device
4. Top-most, then left-most end

### What gets marked for checking

- Size, type or band differs between two sheets showing the same cable
- An end refers to a drawing that was not uploaded
- Band missing from the drawing (assumed from prefix)
- Prefix and band disagree (e.g. a CE cable marked B2)
- Two sheets both say `FROM` (or both `TO`) for the same cable
- A label attached by a leader arrow (worth a glance)
- No line, size, type, source or destination found

---

## How it works

```
PDF ──► pdfread.js ──► engine.js: extractDrawing ──► engine.js: mergeDrawings ──► excel.js ──► .xlsx
        text + lines     one JSON per sheet            one row per cable          template
```

| File | Job |
|---|---|
| `src/pdfread.js` | Uses pdf.js to read every text string (with position and angle) and every straight line from the page |
| `src/engine.js` | `extractDrawing`: finds the title block, the board header strip and its columns, boxes, cable labels; pairs each label with its size/type text and its cable line; follows the line both ways to find what is at each end. `mergeDrawings`: joins all sheets, resolves cross-references, sets direction, checks, sorts |
| `src/rules.js` | Company conventions: acronyms, abbreviations, band → voltage, prefix → band, row order, direction |
| `src/excel.js` | Loads the template with ExcelJS and fills the header (I1–I4, A3) and rows from row 6, copying row 6's style |
| `src/app.js`, `src/index.html` | The web page |
| `build.mjs` | Bundles everything (and the template) into one HTML file, `docs/index.html` |
| `cli.mjs` | Same engine from the command line, writes JSON |
| `test/run-all.mjs` | Runs every test project, compares with its correct schedule, checks against the baseline |
| `.github/workflows/test.yml` | Runs the tests on GitHub after every commit |
| `tools/dump-geometry.mjs` | Debug: dumps all text and lines from a PDF |

### How a cable is traced

1. **Label.** Any text matching `L25NA1001`, `CE25NA1004-1`, `E25NA0001` … with an optional `(B1)`.
2. **Line.** The nearest line parallel to the label within about 1.5 text heights. Horizontal labels beside a vertical line (vendor `LC` labels) and labels with a leader arrow are handled too.
3. **Size/type.** Text on the other side of the line from the label, same orientation.
4. **Ends.** The line is followed through joins and across the small gap at the `P`/`C` marker until it stops. At each end, in order:
   - just under the header strip → that board, and the column's DESCRIPTION gives the way
   - on the edge of a box → the text inside the box
   - otherwise → the nearest text block, favouring the direction the line was going (`FROM DRAWING …`, `FROM DNO`, `STORM RETURN PUMP NO.1` …)

### What the drawings must have

- Vector PDF from AutoCAD (not a scan). The page warns if a PDF has no text.
- Header strip with row titles `REFERENCE` and `DESCRIPTION`, last row `TAG` or `WAY`
- Title block captions `W&B DRAWING No:`, `CLIENT DRAWING No:`, `REV:`, `TITLE:`, `PROJECT:`

---

## AI cross-check (optional)

The rules engine reads the drawings exactly but only understands drafting styles it has rules for. The optional AI cross-check adds a second, independent reading by an AI model (Google Gemini, free tier), so new drawing styles and scanned sheets are still covered without anyone writing new rules.

**How it works**

1. **Read.** Each sheet is sent to the AI as images (an overview plus close-up tiles, so small text stays readable) with the list of cable references the rules engine found, but **not** the rules engine's answers. The AI reports each cable's ends, cores & size, type and band.
2. **Check.** The AI's answer is checked by code before it is used: fixed answer format, valid references only, and any cable the rules engine did not find must appear in the drawing's own text, or it is discarded.
3. **Compare.** The AI's reading goes through the same merge and naming rules as the rules engine, then the two are compared field by field.
4. **Review.** Only the fields where they disagree go back to the AI, with both candidate values and the drawing, to say which one the drawing shows and why.
5. **Result.** Every row gets a status: **Agreed**, **Disputed**, **Partly confirmed**, **AI only**, **Rules only** or **Not checked**. Disputed fields show both values with the AI's reason; one click picks the right one. Nothing the AI decides is applied without being marked for checking.

It is an AI step inside a fixed pipeline, not an agent: the code decides what happens, the AI only reads.

**Using it:** tick *AI cross-check* in step 02, paste a Gemini API key (free from [Google AI Studio](https://aistudio.google.com) → Get API key), and click *Run AI cross-check*. The key can be remembered in your browser; it is never stored in this repository or on the website.

**Privacy:** the rules engine never sends drawings anywhere. The AI cross-check sends images of the drawings to Google. On Google's free tier, Google may use what is sent to improve its products.

| File | Job |
|---|---|
| `src/ai/render.js` | Turns a PDF page into an overview image and close-up tiles of the diagram area |
| `src/ai/prompt.js` | The fixed instructions and answer formats for the AI (`PROMPT_VERSION`) |
| `src/ai/gemini.js` | The only file that talks to Google; picks the newest free Flash model, retries on limits |
| `src/ai/crosscheck.js` | Read → check → compare → review → status, plus saving/replaying answers for tests |

**Tests:** a project's `ai-answers.json` holds the AI's saved answers. `npm test` replays them (free, no key needed) and reports *Rules alone*, *AI alone* and *Rules + AI*. To ask the AI again: `GEMINI_API_KEY=... node test/run-all.mjs --ai-live <project>`.

## Accuracy tests

Every folder in `test/projects/` is one real project: its BCD PDFs plus the checked, correct cable schedule. `npm test` builds each schedule with the tool and compares it cable by cable with the correct one.

```
test/projects/
  gaskell-st/
    DT.pdf  CSO.pdf  BS.pdf  MDB.pdf      the BCDs
    correct_schedule.xlsx                  the checked schedule
    settings.json                          optional: { "direction": "field-first" }
```

**Runs automatically.** GitHub Actions (`.github/workflows/test.yml`) runs the tests on every commit. The ✅ / ❌ next to each commit shows the result, and the run's page on the **Actions** tab shows the scorecard and every difference.

**Catches regressions.** `test/baseline.json` stores the last accepted scores. If a change makes any project score lower, the run fails. After an improvement, `npm run test:update-baseline` accepts the new scores.

**Adding a project:** create `test/projects/<project-name>/`, put in the BCD PDFs and the correct schedule (.xlsx), and commit. The next run reports its scores as *new*. Fix what it shows, then update the baseline.

Current results (Gaskell Street, 4 BCDs, 54 cables):

| Cables found | Right two ends | Right direction | Cable type | Cores & size | Voltage | Band |
|---|---|---|---|---|---|---|
| 54/54 | 52/54 | 26/54 | 49/54 | 53/54 | 54/54 | 54/54 |

The remaining differences are mostly in the hand-made schedule, not the tool: it writes direction two different ways (field → board on the DT sheet, board → field on the others), uses a short name (`CSO LCP`) in one place, and has cable types that differ from the drawing text. E25NA0001 points to a drawing that was not in the set.

## Developing

```bash
npm install
npm run build         # docs/index.html, the public page (libraries from cdnjs)
npm run build:local   # dist/local-test.html (libraries from node_modules, serve with: python3 -m http.server)
npm run extract -- drawings/*.pdf   # writes out.json
npm test              # run every project in test/projects/ and compare with its correct schedule
```

To change the template, replace `template/Cable_Schedule_Template.xlsx` (sheet name `Cable Schedule`, headers in row 5, data from row 6) and rebuild, or use **use a different .xlsx** on the page.

Libraries: [pdf.js](https://github.com/mozilla/pdf.js) 4.10.38 (Apache-2.0), [ExcelJS](https://github.com/exceljs/exceljs) 4.4.0 (MIT), esbuild (build only).
