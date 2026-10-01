# Mentimeter: how it works (research for zqhoot)

Access date: 2026-09-29. Purpose: understand Mentimeter's behaviour so zqhoot can design its own original product. Nothing here is a spec to copy.

**Method and confidence.** WebFetch was blocked for help.mentimeter.com and www.mentimeter.com (tried once each, `EGRESS_BLOCKED`). Every fact below therefore comes from WebSearch result summaries of the named pages, not from reading the pages. The summariser paraphrases, so wording is not verbatim and page attribution is best-effort (it is the page the summary was drawn from, chosen from the result list). The WebSearch budget (200 calls) ran out before I could run the last three planned queries (Menti Live vs Form vs Pulse, results animation, "hide results" detail); those gaps are listed under "Not verified". Numbers are copied as the summaries stated them. Re-check load-bearing numbers against the live help centre before committing to a design.

Reference format: `[n, primary]` = source n, Mentimeter's own site/help centre; `[n, secondary]` = third party. **Inference:** marks my own reasoning. No background-knowledge facts are included; gaps are marked "Not verified".

---

## Key findings

- Join is by an **8-digit code** typed at **menti.com**, or by QR code or a direct voting link [2, 4, primary].
- The 8-digit code is **temporary**: it changes after the presentation has been inactive for 2 days, and can be extended to 2, 7 or 14 days. The QR code and link stay valid while the Menti is open [1, primary].
- Default is **presenter-paced**: phones only show the slide the presenter is on, and after voting show "Please wait for the presenter to show the next slide". **Survey mode** is the audience-paced alternative [6, 5, primary].
- **Word cloud:** 25 characters per response, everything shown lowercase, up to 400 unique words shown, number of responses per participant is configurable [8, 9, primary].
- **Open ended:** 200 characters per response, multiple responses per person on by default, two layouts (Speech Bubbles, Flowing Grid), optional voting on responses [9, 10, 43, primary].
- **Ranking uses Borda count**; **100 Points** uses -10/+10 buttons from a 100 budget; **quiz** is 1000 to 500 points by speed, or fixed 1000 [14, 15, 21, primary].
- Presenter controls during a session are small: `H` hides/shows results, `C` turns responding on/off; a closed slide shows participants "Presentation is closed" [25, 26, 27, primary].
- **Free-text moderation is mostly post-hoc**: a language-selectable profanity filter that masks or removes in the presenter view (raw text still on the results page), plus delete-after-the-fact. Approve-before-display is documented for **Q&A** on paid plans [22, 23, 20, primary].
- **Anonymous by default.** Participant names, Quick Form and Verified Participants are paid features. Double voting is limited per device via cookies [28, 29, 30, 38, primary].
- **Limits:** Free plan 50 participants per month; paid plans any audience size; quiz slides capped at 2,000 participants; contact Mentimeter above 10,000 (one retrieval said 20,000). No rate limits found [32, 33, 34, primary].
- **Export:** XLSX (paid; per question, per voter, per session) and PDF (Menti Live only). No CSV found [39, 40, primary].
- Do not copy: name and product names (Menti, Mentimote, Menti Live), logo, palette, the custom "Menti Sans" typeface, quiz music, and characteristic UI strings (section 9).

---

## 1. Joining

- **Code format and length:** 8-digit code, entered in a text field at www.menti.com [2, primary]. Whether it is displayed grouped (e.g. with a space) is Not verified.
- **Join URL:** menti.com for code entry [2, primary]. Participants can alternatively be sent a **voting link** [4, primary]; the link's path format is Not verified.
- **QR code:** participants open the device camera and scan [2, primary]. An Instructions slide shows the menti.com address plus code, or the QR code [53, primary]. Pressing `i` in the presentation view shows voting instructions and QR code [25, primary].
- **Permanent or per session:** the code belongs to the presentation ("Menti"), not to a run. It is temporary: it changes after the presentation has been inactive for 2 days (48 hours); the next time you present you automatically get a new code [1, primary]. Validity can be prolonged by 2, 7 or 14 days through the Share menu [1, primary].
- **QR/link validity:** the QR code is unique to the Menti and unchanged even when the 8-digit code is renewed [1, 3, primary]. The voting link and QR keep working for as long as the survey is open [1, primary]. Mentimeter recommends link or QR over the code for longer-running collection [1, primary].
- **Conflicting claim:** one search summary said the standard voting code "usually expires after four hours". I could not tie that to a named page and it contradicts [1]; treat as unverified (see last section).
- **Naming drift:** help-centre URL slugs still say "voting" (e.g. `how-to-enter-the-voting-session`) while article titles now say "participate" [2, primary]. **Inference:** the product has moved terminology from "voting" to "participation" as it added non-vote content.

## 2. Slide types

Product family: help articles are split into **Menti Live**, **Menti Form** and **Menti Pulse** [47, primary]. Several features below are Menti Live only. Option caps for Menti Live: Multiple Choice 12, Scales 8, 2 by 2 Grid 10; quiz slides 6; Menti Form Multiple Choice has no limit [47, primary]. Question description max 300 characters [47, primary].

### Multiple choice
- **Behaviour:** "Select multiple options" lets the audience choose several answers, and the presenter sets how many they may select [12, primary]. With multi-select on, the percentage shown is the share of participants who picked each option, not a share of total selections [12, primary]. Options can carry images, square 1:1 [12, primary].
- **Chart types:** Bars, Donut, Pie and Dots [11, primary].
- **Presenter screen:** live chart in the chosen layout [11, primary]. **Phone:** the current question and its options; in presenter pace only the current slide is visible [6, primary]. Exact phone controls (tap then submit?) Not verified.

### Word cloud
- **Entries per participant:** the presenter picks "Number of responses" from a dropdown [8, primary]. The dropdown's range is Not verified.
- **Max characters:** 25 per response ("works best for short responses (up to 25 characters)") [8, 9, primary].
- **Case:** capitals are not displayed; all responses show in lowercase "to avoid unwanted duplicates" [8, primary].
- **Merging and sizing:** the most common responses appear larger [8, primary]. Merging is documented only as lowercase normalisation; any trimming, punctuation or plural/stem handling is Not verified. The size function (linear, log, rank-based) is not documented in what I retrieved.
- **Cap:** the cloud accepts up to 400 unique words; beyond that the 400 most popular are shown [8, primary].
- **Presenter:** live cloud; hover a word and click to remove it (after pressing `C` to stop responding) [23, primary]. **Phone:** a short text input, repeated up to the response cap [8, 9, primary].

### Open ended
- **Character limit:** up to 200 characters per response [9, 10, primary].
- **Multiple submissions:** "Multiple responses per person" is on by default and can be toggled off [10, primary].
- **Layouts:** Speech Bubbles (several responses on the slide) and Flowing Grid (same, but the slide auto-scrolls as responses grow) [11, 10, primary]. Presenter can scroll in full screen, and toggle auto-scroll [10, primary].
- **Voting on responses:** via Insights then Vote in the presenter view; presenter chooses how many votes each participant has and whether they must be on different responses; voting starts with Enter or a bottom-of-slide button [43, primary]. Voting on responses blocks Survey mode [43, 10, primary].
- **AI grouping:** with more than 11 responses the presenter can group them into labelled thematic clusters; voting still works after grouping [43, 44, primary].
- **Presenter:** response boxes with a Trash icon (bottom left) for removal [23, primary]. **Phone:** free-text box, resubmit if multiple is on [10, primary].

### Scales
- **Model:** participants rate statements (or give numeric answers) by dragging a pointer to a score [13, primary]. Top and bottom values are editable on the canvas, min/max in Range fields, mid-range labels under Dimensions [13, primary]. Max 8 options in Menti Live [47, primary].
- **Average:** a "Show statement average" toggle in the Edit tab shows an average (summary wording: "an average of all statements") [13, primary]. Whether this is per-statement or across statements is ambiguous in the summary.
- **Presenter:** a pointer per statement that slides left to right as responses arrive, plus a distribution graph just above each line [13, primary]. **Phone:** drag control per statement and a **Skip** button; skip counts appear on hover in the presenter view [13, primary].

### Ranking
- **Aggregation:** points system ("Borda count"): the item ranked first gets as many points as there are items, then descending. Example: 5 items gives 1st = 5, 2nd = 4, 3rd = 3 [14, primary]. Final order is by total points across participants [14, primary].
- Participants may rank all items or only some [14, primary]. How unranked items are scored is Not verified. Phone layout (drag to reorder?) Not verified.

### Q&A ("Questions from Audience")
- **Modes:** enabled on all slides, the audience can ask at any time, via an "Open Q and A" button on each slide on their device; alternatively a dedicated Q&A slide restricts asking to when that slide is shown [18, 19, primary].
- **Upvoting:** if the presenter allows the audience to see others' questions, they can upvote [18, 19, primary].
- **Presenter:** the most upvoted question is shown automatically; `Enter` marks it answered, moves it to the bottom of the list and shows the next unanswered question with most upvotes [18, primary].
- **Question length limit:** Not verified.

### Quiz competition
- **Scoring:** two modes. Time-based: correct answers earn between 1000 and 500 points depending on how fast they are submitted. Fixed points: every correct answer earns 1000. Incorrect or no answer earns zero. Time limit is set per question [21, primary]. The exact time-to-points curve is not documented in what I retrieved (linear is not confirmed).
- **Leaderboard:** a leaderboard slide shows the top 10 with totals so far; can follow every question, only the end, or both; scores accumulate across questions [21, primary].
- **Lobby:** participants join an initial lobby, get an avatar and enter a nickname; devices are remembered so the same avatar and nickname return [21, primary].
- **Limits:** quiz slides max 6 answer options and 2,000 participants [47, 32, 33, primary].
- **Music:** optional upbeat "gameshow" tracks toggled in Quiz settings [21, primary].

### 100 Points
- Each participant starts with 100 points and distributes them across items with -10 and +10 buttons; items rearrange by points received; based on the "100-dollar method"; Menti Live only [15, primary].

### 2 by 2 Grid
- Max 10 options in Menti Live [47, primary]. Placement mechanics and result rendering Not verified (article 410474 appeared in results but no content was extracted).

### Pin on Image
- Presenter uploads an image; participants tap it to set a pin; presenter can mark a "correct area" via "Set correct area" [17, primary]. Result rendering (heatmap? pin dots?) and pins per participant Not verified. Not relevant to v1.

## 3. Live result rendering

- Results update as votes arrive: the word cloud "updates live to highlight common responses" [8, primary]; Scales pointers move as each response comes in [13, primary]; results display in the slide according to its settings and update as participants submit [24, primary].
- **Hide/show:** `H` toggles results, so participants are not influenced by others' answers [24, 25, primary]. "Show responses" in the Presentation menu restores them [24, primary].
- **Hide until a time:** an explicit "hide results until X" setting was not found. The documented mechanism is the manual `H` toggle. Not verified.
- **Audience-side results:** per-slide setting of "Never show" or "After responding" for what participants see on their phones [24, 41, primary]; in Menti Pulse, results are always shown to participants after they submit [24, primary]. Page attribution for this sentence is low confidence.
- **Animation:** only the Scales slide-left-to-right pointer is documented. Transitions for bars, cloud reflow and speech bubbles Not verified.
- After the session, participants can be prompted for an email to receive the results, if the presenter enabled audience download [41, 42, primary].

## 4. Moderation

- **Profanity filter:** presenter selects one or more languages; each has a "user-generated list of words" [22, primary]. Filtered input is masked or removed from the presentation view, but all input, including bad words, stays retrievable on the results page [22, primary]. Activated from the Language preferences in the Settings menu [22, primary].
- **Filter limits:** it does not remove combined swear words or innocent words containing a profane string (Scunthorpe problem), and the docs concede it cannot keep up with new profanities [22, primary].
- **Languages** (as listed in the summary of the profanity-filter article; the article may reflect the interface language list, so medium confidence): Catalan, Chinese, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Hindi, Hungarian, Icelandic, Indonesian, Italian, Japanese, Lithuanian, Norwegian, Polish, Portuguese, Punjabi, Romanian, Russian, Serbian, Slovenian, Spanish, Swedish, Tamil, Turkish, Ukrainian, Welsh (32) [22, primary].
- **Live removal, word cloud and open ended:** press `C` to stop responding, then hover-click a word (cloud) or click the Trash icon on a response box (open ended); Menti Live only; also possible from the Mentimote remote [23, 45, primary]. Why responding must be stopped first, and whether removal is reversible, is Not verified.
- **Q&A moderation:** on Pro, Conference and Enterprise, the presenter turns on moderation in Settings or on the slide, then approves or dismisses incoming questions before the audience can upvote; approved ones appear on the presenter screen and audience devices; a moderator view has a "Show question!" action to highlight one [20, primary].
- **Separate moderator role:** no distinct moderator role was found. Documented patterns are (a) the presenter moderating from a phone via Mentimote [45, primary] and (b) advice that a colleague moderates while another presents [33, 46, primary]. Collaborator access levels are Edit, Comment, View, and Edit needs a paid role [48, primary]. Whether a colleague can moderate Q&A from their own login without Edit access is Not verified.
- Approve-before-display for Open Ended or Word Cloud was not found; only post-hoc removal [23, primary].

## 5. Anonymity model

- **Default:** anonymous; identification is opt-in (the identity article frames it as "anonymous by default, identified by choice", per the summary) [28, primary].
- **Participant names:** Pro or Enterprise; participants must enter a name before accessing the Menti; names show in selected places and on the Results page; off by default, enabled per Menti [29, primary].
- **Quick Form slide:** Pro or Enterprise; collects name, email, a date, or option choices [31, primary]. Open Ended can also be used to ask for identifiers, with a warning that this makes responses non-anonymous [28, primary].
- **Verified Participants:** Enterprise; participants log in through the organisation's identity provider [30, primary].
- **Quiz:** avatar plus nickname, remembered per device [21, primary].
- **Device handling:** cookies must be enabled on the device; one response per device by default; Pro, Conference and Enterprise can allow multiple submissions per device, with each person tapping "Participate again" [38, 36, 37, primary].
- **Data collected beyond this** (IP, user agent, retention): Not verified.

## 6. Audience pacing and states

- **Presenter pace (Presentation mode), default:** only the presenter's current slide is available on phones; participants move on only when the presenter does [6, primary].
- **After voting:** phone shows "Please wait for the presenter to show the next slide" [6, primary].
- **Presenter advances early:** participants are notified and can stay on the previous question to submit, or press "Go to slide" [6, 26, primary].
- **Survey mode (audience pace):** participants start at the first question and proceed at their own speed until done; voting stays open as long as needed [5, 6, 7, primary]. Not available if Open Ended voting is enabled [43, primary].
- **Closed states:** `C` toggles responding for the current slide [25, 26, primary]; participation can be turned off for the whole presentation [27, primary]. With participation off, phones show "Presentation is closed" [26, 27, primary].
- **Presenter controls:** `H` results, `C` responding, `i` instructions/QR, `k` shortcut list, arrows for slides [25, primary]; the Mentimote phone remote does slide advance, notes, Q&A moderation and hide/show results [45, primary].

## 7. Limits

- **Free plan:** 50 participants per month; counter resets monthly on the account-creation date; 200 slides per presentation [34, 35, primary]. On hitting the limit the same presentation can continue for 8 hours, other presentations are blocked at once [32, 34, primary]. One summary also said "for one presentation, you can present to unlimited participants", which sits awkwardly with this; ambiguity noted.
- **Paid plans (Basic, Pro, Enterprise):** any audience size [32, primary]. Mentimeter never stops participants joining a running presentation; going over the limit gets an 8-hour grace period [32, primary].
- **Quiz slides:** 2,000 participants; other slide types "work perfectly up to several thousand" [33, 32, primary].
- **Notify threshold:** email hello@mentimeter.com at least 2 business days ahead above **10,000** participants [33, 32, primary]. One earlier retrieval of [32] said **20,000**. Conflict unresolved.
- **Presenter bandwidth guidance:** 10 participants 0.5 Mbit/s, 50 = 2.5, 100 = 5, 500 = 15, 1000 = 30 Mbit/s; prefer mobile network over venue Wi-Fi for the audience; wire the presenter laptop [33, primary].
- **Per-response limits:** cloud 25 chars, open ended 200 chars, option caps above [9, 47, primary].
- **Rate limits:** none documented in what I found. Searched: rate limit, throttling, voting limit per device, API limits (help centre, www, docs.mentimeter.com).

## 8. Results export

- **XLSX:** Results page, Download, "Spreadsheet (XLSX)"; all responses broken down per question, per voter and per session; requires a paid plan [39, primary]. A separate summary suggested Q&A export to Excel is available on Free; ambiguity noted [34, primary].
- **PDF:** full presentation or selected slides ("Choose slides" reduces size); Menti Live only [39, 40, primary]. Screenshots are also covered [40, primary].
- **Audience download:** participants can receive results by email [42, primary].
- **CSV:** not mentioned in anything retrieved.

## 9. Brand elements we must NOT copy

- **Names:** "Mentimeter", "Menti" (used as a noun for a presentation), "Menti Live / Menti Form / Menti Pulse", "Mentimote" (remote), the menti.com domain [45, 47, 2, primary]. "Voting code / join code / participation code" are descriptive, but avoid the "Menti" prefix pattern.
- **Logo:** updated in a brand refresh announced on the Mentimeter blog (summary dates it November 2025) [49, primary]. Paid plans replace the Mentimeter logo (top right of presentations) with the customer's, 2:1 ratio recommended, which shows the logo is a persistent on-screen element [52, primary].
- **Colours:** the refresh changed the Menti light and dark themes "to match the new brand colors" [49, primary]. Exact hex values: Not verified (Brandfetch page [51] not summarised).
- **Typography:** a custom typeface, **Menti Sans**, with quirky details referencing bar charts, made with Letters from Sweden; the identity draws on infographic visual cues [50, 51, secondary]. Whether Menti Sans survived the 2025 refresh: Not verified.
- **Sounds:** upbeat "gameshow" quiz music tracks [21, primary]. Do not reuse or imitate the tracks.
- **Characteristic copy (as found):** "Please wait for the presenter to show the next slide" [6], "Presentation is closed" [26, 27], "Open Q and A" [19], "Show question!" [20], "Go to slide" [6], "Participate again" [37], plus "Set correct area" [17] (all primary). Write our own strings.
- **Identity pattern to avoid:** bar-chart-inspired letterforms and a bright infographic palette are the core of their look [50, secondary]. Choose a different visual metaphor.

---

## Implications for zqhoot

All of this section is **Inference**, aimed at the v1 non-quiz types: poll, word cloud, open ended with moderation, rating scale.

1. **Join.** Session-scoped short numeric code plus a separate unguessable link/QR token. Renew or expire on idle with a host-controlled extension, mirroring the code/QR split in [1]. **Inference:** for one-room audiences of ~400, a 6-digit or short-alphabet code is enough; the code space only has to cover concurrent sessions on one deployment, not Mentimeter's global tenancy. Keep the code and QR/link independent so the QR on the projector never changes mid-session.
2. **Pacing.** Ship presenter-paced only in v1. Model a slide's state as one record `{slideId, open|closed, resultsVisible}` broadcast to all sockets. Phone states needed: answer, waiting-for-next, closed, early-advance prompt. Defer audience-paced survey mode; it changes the data model (per-participant cursor).
3. **Poll.** Single and multi-select with a host-set max selections; multi-select percentages as share of participants, not of selections [12]. Cap options around 12. Ship bars first; donut/pie/dots are cosmetic. **Inference:** aggregate with atomic per-option counters (DynamoDB `ADD`, or an in-memory map on the VM) so vote writes are O(1) and results need no scan.
4. **Word cloud.** Server-side normalisation (trim, lowercase, collapse whitespace), 25-character cap, host-set responses per participant, and a cap of top N distinct words returned to the projector (Mentimeter uses 400 [8]). Store a counter per normalised word. Size is a monotone function of count; pick our own scaling. Consider Unicode case folding since zqhoot may serve non-English rooms.
5. **Open ended and moderation.** 200-character cap, multiple-responses toggle. Store raw text and a `hidden` flag, never delete, so exports can include hidden items as Mentimeter's filter does [22]. Offer what Mentimeter does not document for free text: an optional **hold-for-approval queue**, plus one-click hide without stopping responses first [23]. Profanity filter as pluggable per-language word lists with word-boundary matching (avoids Scunthorpe cases the docs admit [22]), applied at display time not write time. Use one moderator capability separate from the host, since no separate moderator role was found in [20]/[48]; on AWS this is just a second token scope, on the VM a second auth token.
6. **Rating scale.** Statement list with host-set min/max and labels, a Skip option, per-statement average plus a histogram [13]. **Inference:** store `sum`, `count`, and per-bucket counts per statement; average = sum/count needs no per-vote reads. Define whether "average" is per statement or across statements explicitly; the source is ambiguous.
7. **Live rendering and load.** For 400 phones, do not broadcast per vote. **Inference:** coalesce updates and push a snapshot every ~250 to 500 ms to the presenter screen only; phones need only their own ack and state changes unless results are shown on phones. Lambda-fronted WebSockets bill per message, so this also caps cost. Provide a host `H`-style hide-results toggle and a `C`-style close toggle [25].
8. **Anonymity.** Anonymous by default with a random participant id in browser storage for dedupe and for idempotent resubmits (`participantId+slideId+n`). Mentimeter relies on cookies for one-per-device [38]; we can do the same and avoid collecting personal data. Names optional, off by default.
9. **Limits.** Treat 400 as a design ceiling, well under what Mentimeter documents as trivial. Put our own explicit input caps (25/200 chars, option cap, per-participant response cap) server-side. No public rate limits exist to copy, so pick ours (e.g. per-connection message-rate ceiling).
10. **Export.** CSV and JSON first (Mentimeter's docs show XLSX and PDF only [39, 40]); include hidden responses with a flag; per question, per participant id, per session.
11. **Brand.** Original name, palette, type and copy; avoid bar-chart letterforms and the strings in section 9.

---

## Not verified / open questions

- **Code display and link format:** whether the 8-digit code is shown grouped; path format of the voting link. Searched: join code format, voting link.
- **Four-hour claim:** one summary said the code "usually expires after four hours"; contradicts the 2-day rule [1]. Source not identifiable. Searched: join code validity (twice).
- **Word cloud:** dropdown range for responses per participant; any merge rules beyond lowercasing (trim, punctuation, stemming, plurals); size function. Searched: word cloud duplicates, similar words grouped, number of responses.
- **Quiz:** exact time-to-points curve between 1000 and 500 (linear not confirmed). Searched: quiz points formula, faster answers more points.
- **Q&A:** question character limit; whether names are optional on Q&A; behaviour when moderation is off; separate moderator login/role. Searched: Q&A moderation, moderator role, character limit.
- **Ranking:** how unranked items are scored; 2 by 2 Grid mechanics; Pin on Image results rendering and pins per person.
- **Phone UI details** for most slide types (buttons, layout, confirmation screen after submit). A "Thank you for voting" screen was searched for and not found; only "Please wait for the presenter to show the next slide" and "Presentation is closed" are confirmed.
- **"Hide results until" setting:** not found; only the manual `H` toggle and per-slide "Never show / After responding" for phones. Animation details beyond Scales pointer movement.
- **Menti Live vs Form vs Pulse:** exact feature split (query not run; search budget exhausted).
- **Participant thresholds:** 10,000 vs 20,000 notify threshold conflict; Free-plan wording ("50 participants per month" with an 8-hour grace, versus "unlimited participants for one presentation").
- **Export:** whether Free can export Q&A to Excel (summary ambiguous); presence of CSV.
- **Rate limits and per-device throttling:** none found. Searched: rate limit, throttling, API limits, voting limit per device.
- **Data collected from participants** beyond cookies, retention periods, and legal/GDPR posture: not researched.
- **Brand:** hex colour values; current typeface after the 2025 refresh; brand-guideline document (none found; press page contact only [51]).
- **Attribution caveat:** page-level attribution for "Never show / After responding" and "Pulse results always visible" is low confidence.

---

## Sources

All accessed 2026-09-29 via WebSearch summaries (pages not fetched directly).

1. https://help.mentimeter.com/en/articles/2780681-how-long-is-my-join-code-valid [primary]
2. https://help.mentimeter.com/en/articles/410537-how-to-participate-in-a-menti (also listed as https://help.mentimeter.com/articles/410537-how-to-enter-the-voting-session) [primary]
3. https://help.mentimeter.com/en/articles/422271-share-the-qr-code [primary]
4. https://help.mentimeter.com/en/articles/410895-let-your-audience-connect-to-your-menti-via-a-link [primary]
5. https://help.mentimeter.com/en/articles/6385721-how-to-run-a-survey-with-mentimeter-survey-mode [primary]
6. https://help.mentimeter.com/en/articles/410899-how-the-presentation-mode-affects-your-menti [primary]
7. https://www.mentimeter.com/blog/menti-news/live-presentation-or-survey-the-ultimate-guide-to-voting-pace [primary]
8. https://help.mentimeter.com/en/articles/410469-how-to-use-the-word-cloud-slide [primary]
9. https://help.mentimeter.com/en/articles/410541-providing-textual-input [primary]
10. https://help.mentimeter.com/en/articles/410470-how-to-use-open-ended-slides-in-menti-live (also https://help.mentimeter.com/en/articles/410470-how-to-use-open-ended-slides) [primary]
11. https://help.mentimeter.com/en/articles/2350085-change-the-results-layout-for-your-presentation [primary]
12. https://help.mentimeter.com/en/articles/410459-how-to-use-multiple-choice-slides-in-menti-live [primary]
13. https://help.mentimeter.com/en/articles/410471-how-to-use-scales-slides [primary]
14. https://help.mentimeter.com/en/articles/2780579-how-to-use-ranking-slides [primary]
15. https://help.mentimeter.com/en/articles/410475-how-to-use-100-points-slides [primary]
16. https://help.mentimeter.com/en/articles/410474-how-to-use-2-by-2-grid-slides [primary] (listed only; no content extracted)
17. https://help.mentimeter.com/en/articles/4582546-how-to-use-pin-on-image-slides [primary]
18. https://help.mentimeter.com/en/articles/1501502-gather-questions-from-your-audience [primary]
19. https://help.mentimeter.com/en/articles/1501608-questions-from-audience-the-audience-perspective [primary]
20. https://help.mentimeter.com/en/articles/1840522-moderate-your-q-and-a-session-to-ensure-a-great-experience [primary]
21. https://help.mentimeter.com/en/articles/410463-how-to-create-a-quiz-competition (also .../4305015-how-to-host-the-quiz-competition, .../2968253-participating-in-a-quiz-competition, .../2968106-select-answer-quiz-competition-slide) [primary]
22. https://help.mentimeter.com/en/articles/1649840-mentimeter-s-profanity-filter [primary]
23. https://help.mentimeter.com/en/articles/2780529-remove-input-from-word-clouds-and-open-ended-questions [primary]
24. https://help.mentimeter.com/en/articles/422266-hide-or-show-results [primary]
25. https://help.mentimeter.com/en/articles/410524-keyboard-shortcuts [primary]
26. https://help.mentimeter.com/en/articles/422270-how-to-enable-and-disable-participation-for-a-specific-slide [primary]
27. https://help.mentimeter.com/en/articles/2780656-turn-off-participation-for-the-whole-presentation [primary]
28. https://help.mentimeter.com/en/articles/410525-how-to-identify-participants (and .../10774022-choosing-participant-identity-settings-for-your-use-case) [primary]
29. https://help.mentimeter.com/en/articles/10002117-gather-participant-names [primary]
30. https://help.mentimeter.com/en/articles/10205219-how-to-use-verified-participants [primary]
31. https://help.mentimeter.com/en/articles/1840520-collect-email-addresses-and-other-information-from-your-audience-with-quick-form-slides [primary]
32. https://help.mentimeter.com/en/articles/465589-how-many-people-can-participate-in-a-menti (also .../465589-how-many-people-can-participate-in-a-mentimeter-presentation) [primary]
33. https://help.mentimeter.com/en/articles/14688132-using-mentimeter-at-large-events [primary]
34. https://help.mentimeter.com/en/articles/1258367-what-is-included-in-the-free-account [primary]
35. https://www.mentimeter.com/plans [primary]
36. https://help.mentimeter.com/en/articles/465597-can-i-let-the-audience-respond-several-times-per-device [primary]
37. https://help.mentimeter.com/en/articles/1163326-can-audience-members-respond-separately-on-a-shared-device [primary]
38. https://help.mentimeter.com/en/articles/410950-what-device-to-use-for-participation [primary]
39. https://help.mentimeter.com/en/articles/410566-export-results-to-excel [primary]
40. https://help.mentimeter.com/en/articles/410575-presentation-pdf-and-screenshots [primary]
41. https://help.mentimeter.com/en/articles/410556-what-happens-after-participating-in-a-presentation-session [primary]
42. https://help.mentimeter.com/en/articles/410572-share-your-results-after-the-menti (and .../410888-let-your-audience-download-your-presentation-results) [primary]
43. https://help.mentimeter.com/en/articles/8986162-voting-on-the-responses-to-your-open-ended-question [primary]
44. https://help.mentimeter.com/en/articles/8300577-group-responses-to-your-open-ended-questions-using-ai [primary]
45. https://help.mentimeter.com/en/articles/2233579-mentimote-our-presentation-remote [primary]
46. https://help.mentimeter.com/en/articles/16188519-how-to-use-menti-in-webinars-and-virtual-events [primary]
47. https://help.mentimeter.com/en/articles/465574-why-can-t-i-add-more-options [primary] (Menti Form and Pulse titles: .../16969876-how-to-use-open-ended-questions-in-menti-form, .../16970550-open-ended-questions-in-menti-pulse)
48. https://help.mentimeter.com/en/articles/5422663-collaborate-on-mentis-and-folders-with-colleagues [primary]
49. https://www.mentimeter.com/blog/menti-news/mentimeter-new-brand-refresh [primary]
50. https://www.underconsideration.com/brandnew/archives/new_logo_and_identity_for_mentimeter_by_bold.php [secondary]
51. https://brandfetch.com/menti.com [secondary]; https://www.yun-yu.com/work/mentimeter [secondary]; https://www.mentimeter.com/press [primary, press contact only]
52. https://help.mentimeter.com/en/articles/465571-how-can-i-add-my-own-logo-to-brand-my-menti [primary]
53. https://help.mentimeter.com/en/articles/5766150-show-the-participation-instructions-with-an-instructions-slide [primary]
