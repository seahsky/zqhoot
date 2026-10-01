# Kahoot live game: how it works (research for zqhoot)

Accessed: 2026-09-29. Purpose: understand Kahoot's live-game mechanics so zqhoot can design its own product with original branding. Nothing here is a copy target.

## How this evidence was gathered (read first)

- `support.kahoot.com` and `kahoot.com` returned EGRESS_BLOCKED from WebFetch, so no Kahoot page was read verbatim. `github.com/unixpickle/...` and `github.com/theusaf/...` could be fetched directly.
- Every **[primary]** tag means: the claim came from the WebSearch tool's summary of a Kahoot-authored help-centre or kahoot.com page. It is **not** verbatim page text, and summaries were occasionally inconsistent (flagged below). Text in quotation marks is the summary's rendering of the page.
- **[secondary]** = third-party page (GitHub repos, robots.net). **[secondary-community]** = user-written thread on the Kahoot help-centre forum. Many were seen by title only, and are marked "title only".
- **Inference:** = my own reasoning. **Unverified (background knowledge)** = from memory, not sourced.
- The WebSearch budget (200 calls) ran out before disconnect/rejoin, exports, and brand elements could be researched. Those sections are thin and say so.

## Key findings

1. **Scoring formula** [primary][1]: `⌊ ( 1 - (( {response time} / {question timer} ) / 2 )) {points possible} ⌉`, rounded to the nearest whole number. A correct answer in under 0.5 s bypasses the reduction and gets full points. Points possible: 1000 standard, 2000 double, 0 none.
2. **Answer-streak bonus points no longer exist.** Streaks still display but award nothing [primary][1]. A March 2020 change removed them [secondary-community][31].
3. **Join flow:** PIN at kahoot.it or in the app, then optional 2-step tile pattern, then optional Player Identifier, then nickname or "Spin!" generator [primary][5][6][7]. PIN and QR are valid up to 8 hours [primary][4]. **PIN length is not stated in any Kahoot source I could reach**; secondary sources show 6 digits historically and 7 digits later [39][41][42].
4. **By default phones show answer options only**, not question text. A free host option, "See questions on participant's screen", shows both [primary][11].
5. **Unscored types:** poll, word cloud, and (by category) open-ended, scale and NPS. **Scored:** quiz, true/false, type answer, puzzle, slider, pin answer, and brainstorm (by peer votes, optional) [primary][2][15][17][18].
6. **Slider and pin-answer scoring** is 20% speed, 80% precision, with an answer margin of none/low/medium/high/maximum [primary][1][17].
7. **Multi-select is all-or-nothing** (any wrong pick means 0). The per-correct-answer value is unresolved: search summaries said both "up to 500" and "up to 1000" [primary][1][3].
8. **Leaderboard** shows the top five after every live question and podium shows the top three at the end. Players outside the top 5 see only their score [primary][26], [secondary-community][33].
9. **Team mode:** team score is the average of members' individual scores. A 5-second "team talk" is on by default [primary][20].
10. **Late joiners are allowed by default**; the host can "Lock game joining". Autoplay starts a game 15 s after the last join [primary][7][10].
11. **Caps:** 10-40 players on free plans; event tiers 200 / 1,000 / 2,000 / 5,000 [primary][12][13]. zqhoot's ~400 target sits between Kahoot's Event Standard and Event Plus tiers.
12. **Disconnect/rejoin behaviour and duplicate-nickname handling could not be verified.**

## 1. Joining

- **Where:** "To join via the website, use https://kahoot.it/ and type the PIN"; the Kahoot app is the alternative [primary][5]. After the PIN, "If prompted, enter a Player Identifier (if the host has enabled this feature) and then choose your nickname" [primary][5].
- **PIN nature:** a temporary code for a live or assigned kahoot, generated when the host starts hosting, unobtainable beforehand, expiring when the live session ends; a new session gets a new PIN [primary][4]. Live PIN/QR validity was extended to "up to 8 hours" [primary][4], and a community thread asks for printable QR codes valid 8 hours [secondary-community][45] (title only). Assignment PINs stay active until the host's deadline, settable up to 28 days out [primary][25].
- **PIN length/format:** Not verified in primary sources (searched "how many digits", "6 or 7 digit", Kahoot help-centre and kahoot.com). Secondary evidence:
  - A 2017 GitHub issue: "If you have a 6 pin game code it's fine, but now kahoot has 7 pin codes which don't work with any of these scripts" [secondary][39].
  - A robots.net article says six digits [secondary][41].
  - The kahoot.js README example uses a 7-digit PIN (`9802345`) [secondary][42].
  - SEO listicles claiming 6-8 or 6-10 digits were ignored as unreliable.
  - **Inference:** PIN is numeric and 6-7 digits today; treat as unspecified.
- **QR / link:** the lobby shows the PIN and a QR code that can be enlarged; clicking the PIN copies a direct join link [primary][10][4]. The QR follows the same validity rules as the PIN [primary][4].
- **2-Step Join (host option):** after the PIN, players must "tap or click four tiles in the exact pattern displayed on your host screen". The pattern refreshes "every ~10 seconds" [primary][6]. Purpose: block shared PINs and bots. It is still enforced for QR/link joins [primary][6]. **Discrepancy:** the Live game settings page says the pattern "changes every seven seconds" [primary][7].
- **Player identifier:** a host option used to track players across games and combine reports [primary][9][7]. One summary said players "provide their email"; not cross-checked.
- **Nicknames:**
  - *Friendly nickname generator:* random 2-word nicknames such as "kind tiger". Players tap "Spin!" and get up to three spins; with it on, players cannot type their own nickname [primary][7].
  - *Profanity filtering:* Kahoot keeps a list of "universally inappropriate" words, checks it whenever someone joins, and "automatically" changes a failing nickname "to something neutral" [primary][8]. Hosts can also kick players [10].
  - *Length limit:* Not verified in primary. Secondary sources say 15 characters, spaces counting [secondary][40][41]. The GitHub README statement is from an old exploit context and may be dated.
  - *Duplicate names:* Not verified (searched help-centre for duplicate/unique nickname policy).

## 2. Lobby

- **Host screen:** PIN and QR code [primary][10]. Player nicknames appear as they join; a running count is likely shown, but **Unverified (background knowledge)**, as no source I reached describes the layout.
- **Kicking:** click a nickname in the lobby to remove that player [primary][10]. One summary added "You can remove players only before starting the gameplay"; it wasn't cross-checked.
- **Lock joining:** "lock option next to the start button" [primary][10]; "Lock game joining" in live settings [primary][7].
- **Autoplay:** the game auto-starts if at least one player has joined and 15 seconds pass with no new joins [primary][7].
- **Lobby music:** exists; the host picks a track from a dropdown with preview [primary][7]. Community threads on disabling countdown/lobby music also exist [secondary-community][37] (titles only).
- **Player caps by plan** [primary][12][13][43]:

| Plan | Live participant cap |
|---|---|
| Free/basic (Personal, Student, K-12) | 10-40 depending on category |
| Kahoot! Go | 10 in Classic mode |
| Free Business user (games made from scratch) | 3 |
| Kahoot! 360 Express | 15, sessions limited to 15 minutes |
| Business account (no annual membership) | 20 |
| Free Higher Ed | 10 individuals; 5 teams in team mode |
| K-12 EDU Pro | 2,000 live (assigned up to 10,000) |
| "Premium educational plans" | up to 4,000 (conflicts with 2,000 above; unresolved) |
| 360 Pro Max | 2,000 |
| Event Standard / Plus / Max / Max premium (onboarding required) | 200 / 1,000 / 2,000 / 5,000 |

## 3. Question types and scoring class

Kahoot groups types as "test knowledge" and "collect opinions" [primary][2]. Character limits are from [2] unless stated.

| Type | Key rules | Scored? |
|---|---|---|
| Quiz (single-select) | 2 answers minimum, 6 max (more than 4 needs certain plans); question <=120 chars; answers <=75 chars or image | Yes: 0 / 1000 / 2000 [1][2] |
| Quiz multi-select | Auto-enabled when more than one answer is marked correct; players must tap "Submit" before the timer ends; premium feature | Yes; all-or-nothing [3] |
| True/False | Fixed "True"/"False" labels, not editable, one correct | Yes: 0 / 1000 / 2000 [2] |
| Type answer | 1-4 accepted answers, each <=20 chars; not case-sensitive; multiple spaces count as one; most punctuation ignored | Yes: 0 / 1000 / 2000 [2] |
| Slider | Player marks a value on a scale | Yes: 20% speed + 80% precision; margin none/low/medium/high/maximum [1][2] |
| Puzzle | 3-4 answers (up to 6 on some plans) sorted into order | Yes: speed-based, 0 / 1000 / 2000 [2] |
| Pin answer (drop pin) | Player drops a pin on an image; creator draws the correct area; timer 20 s-4 min | Yes: 20% speed + 80% precision, same margin options [17] |
| Poll | Opinion choice | No points, no per-question leaderboard [primary][2] |
| Word cloud | Question <=120 chars, answers <=20 chars, timer 20 s-4 min | No points [15] |
| Open-ended | Question <=120 chars, response <=250 chars, timer 30 s-4 min | Not stated. **Inference:** unscored, as it sits under "collect opinions" [16] |
| Scale / NPS scale | Opinion / Net Promoter Score rating | Not verified [19] |
| Brainstorm | Ideas per player configurable; ideas grouped by AI; players vote for up to 180 s | Optional: standard, double, or none. Points go to idea authors by votes; voting for your own idea earns nothing [18] |

Notes:
- Brainstorm scoring text was garbled in the summary ("top 3 ideas earn 1000 points per vote" alongside "most-voted idea is worth max points (1000 default), each vote proportional"). Treat the mechanism as unresolved.
- One summary placed "after your participants responded, you can accept other submitted answers as correct so they are awarded points" under puzzle. **Inference:** it more likely applies to type answer.
- Other "experiences" change scoring. **Accuracy** (correctness over speed; partly correct multi-select counts, 1 point per correct answer) [primary][23]. **Confidence** (players state confidence before submitting) [primary][24]. **Unplugged** (shared screen only) [primary][30].

## 4. Timers

- **Options:** quiz-style limits run from 5 seconds to 4 minutes (240 s), with fixed steps such as 5/10/15/20 then 30 s upward [secondary-community][44] (titles + summary). Type-specific ranges: 20 s-4 min for word cloud and pin answer, 30 s-4 min for open-ended, up to 180 s for brainstorm voting [primary][15][16][17][18].
- **Timer disabled:** assignments have a game option to disable the question timer, in which case response time no longer reduces points [primary][1].
- **Everyone answered:** one summary said "When the question timer reaches 0 or after everyone has answered, correct answers are revealed when the graph of responses shows". The summary didn't name its page. Treat as **partially verified** (ends early on full response).
- **Answer lock / changing answers:** No help-centre statement found. Multi-select requires an explicit Submit tap [primary][3]. A community request "Let players change answer before time is over" [secondary-community][34] (title only) and the summary "Kahoot does not have a built-in feature that allows players to change their answers" **suggest single-select answers lock on tap**. **Inference:** not confirmed by a Kahoot article.

## 5. Reveal after the timer

- **Host screen:** the correct answer plus the answer-response graph [primary, single summary, page not named]. For pin answers, all players' pins are shown together on the main screen [primary][17]. Brainstorm shows all ideas, then results/winners after voting [primary][18].
- **Player screens:** summaries said the correct answer is shown to players and that players outside the top 5 see only score, not rank [primary][26]. Community requests to "Reveal correct answer after each question of all devices" and "showing the correct answer at the end of the answering time" [secondary-community][38] (titles only) hint that phones do not always show which option was correct (**Inference**, unconfirmed).
- **Per-question phone feedback** (correct/incorrect, points earned, streak, "N points behind" rank line): **Unverified (background knowledge)**; not confirmed by any source I reached.

## 6. Scoring (Kahoot's own words, via search summary of the primary page)

Source: "How points work" [1]. The page itself could not be fetched. The summary reproduced the steps and the formula as follows.

> 1. Divide the response time by the question timer. For example, if a player responded 2 seconds after a 30-second question timer started, 2 divided by 30 is 0.0667.
> 2. Divide that value by 2. For example, 0.0667 divided by 2 is 0.0333.
> 3. Subtract that value from 1. For example, 1 minus 0.0333 is 0.9667.
> 4. Multiply points possible by that value. For example, 1000 points possible multiplied by 0.9667 is 966.7.
> 5. Round to the nearest whole number. For example, 966.7 is 967 points.
>
> "For math wizards, this formula is expressed as: `⌊ ( 1 - (( {response time} / {question timer} ) / 2 )) {points possible} ⌉`"
>
> "If a player responds correctly in less than 0.5 seconds, the speed reduction formula is bypassed" and they "automatically receive the maximum number of points."

- **Points possible:** toggle Standard (1000), Double points (2000), or no points (0) [primary][1][2].
- **Inference (arithmetic on the formula):** a correct answer at the last instant scores 1 - 0.5 = 0.5 of points possible (500 of 1000). Wrong or missing answers presumably score 0; the summary did not state this. Not verified: whether response time is measured on the client or the server.
- **Streak:** "Having a streak of correct answers does not provide extra points"; streaks are still tracked, with no points [primary][1]. Removed in March 2020 after feedback that bonuses hurt lower performers [secondary-community][31]. Older community text describes a bonus that double points did not double (800 + 200 bonus became 1600 + 200); this is historical [secondary-community][32].
- **Double / no points:** per-question toggle (see above). Brainstorm can also be set to no points so there is no podium [primary][18].
- **Multi-select:** no partial credit; "if a participant chooses any incorrect answer along with their correct selections, they will receive 0 points" [primary][1][3]. Per-answer value is **unresolved**: summaries of [1]/[3] said "up to 1000 points per correct answer they select" (2000 with double), and other summaries said "up to 500 points per correct answer... 2000 points for 4 correct answers, 3000 for 6" and "1000 per correct answer with double, 4000 for 4 correct". The 500 variant is internally consistent. The speed reduction still applies unless the timer is disabled [primary][1].
- **Slider / pin answer:** "20% of the score is the speed and 80% is the precision"; every answer inside the chosen margin scores, and the closer to the target the more points [primary][1][17]. The exact precision curve is not stated.

## 7. Leaderboard, podium, reports

- **During the game:** "A top-five leaderboard appears after each question." In live games it appears automatically after every question, and the summary (community thread [33] and the hosting tips) says it can't currently be toggled to show intermittently [primary][26], [secondary-community][33]. Leaderboards in assignment mode cannot be hidden [secondary-community, thread not identified; the summary cited it alongside [25]]. Poll-type questions show none [primary][2].
- **Player phones:** top-5 players see their rank; below 5th only the score shows [primary][26].
- **End:** a podium of the top three; podium players see a medal icon on their own screen [primary][26]. The Game Over screen offers "Play again" (ghost rematch, below) [primary][21].
- **Reports:** "Kahoot! quiz reports", "How to download and use spreadsheet reports", "How to find endgame reports in the mobile app", and a "Guide to Kahoot reports API" all exist [primary][27][28][29] (titles and search snippets only; columns and formats not verified). Player identifier lets a host merge reports across games [primary][9]. Brainstorm ideas and votes are reviewable in the report [primary][18].

## 8. Team mode, self-paced, ghost mode

- **Team (team vs team)**:
  - Team score is "the average of the individual scores of the team members"; teams appear on scoreboards and the podium [primary][20].
  - Team talk is on by default and gives teams 5 seconds to discuss; hosts can disable it (recommended for video calls) [primary][20].
  - Players are auto-assigned to teams with creature-themed names and illustrations, and teams are rebalanced automatically if players drop out [primary][20].
  - Variants: personal devices, or shared devices where a leader joins and can nickname teammates [primary][20].
  - Free Higher Ed is limited to 5 teams [primary][12].
- **Player-paced / assigned:** "Learner-paced" assignments let participants answer question by question at their own pace, joined by PIN/link/QR, with a deadline up to 28 days out [primary][25]. Leaderboards cannot be hidden [secondary-community, thread not identified]. The timer can be disabled [primary][1].
- **Ghost mode (Rematch):** at Game Over the host can "Play Again" using a past game's data to create "ghosts" that players race against; players rejoin without re-entering the PIN. Also available from the Reports page [primary][21]. Solo mode saves your best score [primary][21].
- **Other experiences:** Classic, Accuracy, Confidence, Team, Professional, Lecture, Unplugged, plus named themed games [primary][22].

## 9. Host screen vs player screen

| Step | Host / projector | Player phone |
|---|---|---|
| Join | PIN, QR code, click-to-copy join link [10][4]; 2-step pattern if enabled [6] | Enter PIN at kahoot.it or app; then pattern (if on), Player Identifier (if on), nickname or "Spin!" [5][6][7] |
| Lobby | Nicknames, kick, lock, start; lobby music [10][7]; count: unverified | Waiting screen (unverified) |
| Question shown | Question and answer options [10] | **Default: answer options only.** With "See questions on participant's screen" on: question and options [11] |
| Answering | Timer countdown, media [Unverified (background knowledge)] | Tap option; multi-select needs Submit [3]; type answer/slider/puzzle use their own inputs [2] |
| Timer ends | Correct answer and response graph [primary, unnamed page]; pin answers all shown [17] | Feedback: partially verified [26][38]; points/streak lines unverified |
| Leaderboard | Top five after each question [26] | Score; rank only if top 5 [26] |
| End | Podium, top three; "Play again" [26][21] | Final score; medal icon if on podium [26] |
| After | Reports, spreadsheet, API [27][28][29] | Not verified |

## 10. Late joiners, disconnects, reconnects

- **Late joiners:** allowed. "As long as the PIN is visible on the screen and you have not locked the game, latecomers can enter the PIN and join"; "Lock game joining" prevents it [primary][10][7]. Score for questions missed while absent: not verified.
- **Disconnect / rejoin / screen lock / same nickname / score retention:** **Not verified.** Searched (budget ended mid-search): "Kahoot player disconnected rejoin same nickname keep score screen locked" and "kicked out of game rejoin keep progress". Seen by title only: community threads "Allow Rejoin Option" [35] and "Rejoining" [36]. **Inference:** rejoin is a known pain point, not a guaranteed feature. Unverified (background knowledge): a player who reloads and re-enters the PIN and the same nickname can resume; confidence low.

## 11. Brand elements zqhoot must NOT copy

Sourced items:
- **Name and domain:** "Kahoot!" (with exclamation mark), and "kahoot" as a noun for a quiz ("host a kahoot"), used throughout [primary][10]. The join domain `kahoot.it` [5].
- **Specific UI copy:** "Spin!" (nickname button), "Play Again", "Game Over", "Team talk", "Lock game joining", "Host live", "See questions on participant's screen" [primary][7][10][11][20][21].
- **Nickname style:** friendly two-word animal-style nicknames such as "kind tiger" [primary][7]. **Inference:** original vocabulary is safer.
- **Team names:** creature names with illustrations [primary][20].
- **Named themed game modes:** Color Kingdoms, Chill Art, Submarine Squad, Tallest Tower, Treasure Trove, The Lost Pyramid, Robot Run, Cosmic Conquest [primary][22].
- **2-Step Join "four tile pattern"** presentation [primary][6]. The mechanism is fine to reimplement; avoid the same 4-tile grid look.
- **Sounds:** lobby music, countdown music and in-game sound effects exist [primary][7], [secondary-community][37]. Do not use or imitate them.
- **Podium with medal icons and top-5 leaderboard styling** [primary][26]. The mechanic is generic; avoid the same visuals.

Unverified (background knowledge), so designers should confirm on kahoot.it:
- The four answer buttons in red, blue, yellow and green with triangle, diamond, circle and square shapes.
- The saturated purple background and the "K!" logo.
- The specific lobby and countdown melodies.
- The overall visual language.

Not researched: Kahoot's trademark or brand-usage policy. Suggest a legal check before launch.

The scoring formula, the 1000-point scale, timers, and team averaging are mechanisms, not obviously protectable brand assets. **Inference:** still consider a distinct points ceiling to avoid confusion.

## Implications for zqhoot (all inference)

1. **PIN:** use a numeric PIN (6 digits gives 1M values, enough for concurrent sessions) with a DynamoDB conditional put for uniqueness and a TTL. Rate-limit join attempts per IP and per PIN. Kahoot added 2-step join because of bots and shared PINs [6]; offer an optional host-visible rotating code.
2. **Joining:** PIN, then optional gate, then nickname, and let players re-enter to resume (see 6). Normalise and dedupe nicknames server-side (case-insensitive, trimmed), reject or auto-suffix duplicates, and add a profanity list plus an optional generator. A 15-char cap [40][41] fits mobile UI.
3. **Phone content:** ship question text on phones by default as a per-session toggle. It is cheaper than forcing players to look up, and it helps accessibility and remote play [11]. Use button labels or icons, not colour alone.
4. **Scoring:** implement Kahoot's formula as one pure function. Timing must be measured **server-side** from the question start timestamp to the message receipt time, both from one clock. On Lambda, cold starts and WebSocket latency add jitter, so a small grace window (Kahoot's 0.5 s full-points bypass suggests latency tolerance) keeps ranking fair [1]. Keep score deterministic and idempotent per (player, question) via a conditional write, so retries don't double-score.
5. **Fan-out at 400 players:** each reveal/leaderboard is roughly 400 `postToConnection` calls on serverless. Send phones only their own result plus rank, and the projector the top five and the histogram. This mirrors Kahoot's "top five, others see score only" [26] and keeps write and push volume down. On the single-VM path the same logic is an in-memory broadcast.
6. **Reconnect:** identify players by a session-scoped token (stored in `localStorage`, with a fallback), not by nickname, since screen lock kills sockets. Keep scores server-side and resume on reconnect. Kahoot's behaviour is unverified, so this is our own design.
7. **Late join and lock:** allow by default with a lock toggle; mark answers for missed questions as unanswered (zero).
8. **Unscored types (poll, word cloud, open-ended)** need no timer-based scoring and can share one "collect" pipeline with aggregation (counts, word counts).
9. **Team mode:** if added, mean-of-members scoring [20] is simple but biases toward small teams that sit out; consider sum of top N or normalising.
10. **Capacity:** ~400 players is above Kahoot's Event Standard (200) [13], so capacity is a competitive selling point. Cap by a configurable limit and test connection counts.
11. **Originality:** avoid everything in section 11. Use a different palette, shape set, sounds, copy and naming.

## Not verified / open questions

- **Exact PIN length and character set.** Searched the help centre and kahoot.com (many queries); only secondary sources (6 then 7 digits).
- **Nickname length limit** (primary), **duplicate-nickname policy**, and reserved/blocked names.
- **Whether the Kahoot lobby shows a player count** and how it lays out.
- **Timer step list exactly** (only community-thread summaries). Behaviour when all players have answered (single unnamed summary). Whether single-select answers can be changed.
- **Points possible for scale/NPS/open-ended;** the slider/pin precision curve; the response-time source (client or server); scoring for wrong answers (one summary claimed "point loss", likely Confidence mode; not adopted).
- **Multi-select per-answer value:** 500 vs 1000 (conflicting summaries of the same primary pages).
- **Phone-side reveal content:** correct/incorrect, points earned, rank line.
- **Disconnect, screen lock, rejoin, score retention;** whether players can be kicked mid-game.
- **Report columns and export formats** (only titles seen).
- **Brand assets:** colours, shapes, logo, music, trademark policy.
- **2-Step Join refresh interval:** ~10 s [6] vs 7 s [7]. **Plan caps:** K-12 EDU Pro 2,000 vs "premium educational plans" 4,000.
- **Next step:** a person with direct access to support.kahoot.com should re-read [1], [3], [6], [7], [12] and [26] verbatim to replace summary-derived quotes.

## Sources

Kahoot help centre / kahoot.com (tag [primary], via search summary):

1. How points work: https://support.kahoot.com/hc/en-us/articles/115002303908-How-points-work
2. Kahoot! question types: https://support.kahoot.com/hc/en-us/articles/115002308428-Kahoot-question-types
3. How to let Kahoot! participants choose more than one answer: https://support.kahoot.com/hc/en-us/articles/360055064374-How-to-let-Kahoot-participants-choose-more-than-one-answer
4. How to find Kahoot! PIN: https://support.kahoot.com/hc/en-us/articles/360000109048-How-to-find-Kahoot-PIN
5. Kahoot! join: How to join a Kahoot! game: https://support.kahoot.com/hc/en-us/articles/360039890713-Kahoot-join-How-to-join-a-Kahoot-game
6. How to use the 2-step Join option to secure your game: https://support.kahoot.com/hc/en-us/articles/35342050693789-How-to-use-the-2-step-Join-option-to-secure-your-game
7. Live game settings: https://support.kahoot.com/hc/en-us/articles/115016055107-Live-game-settings
8. How to handle inappropriate nicknames: https://support.kahoot.com/hc/en-us/articles/115002201267-How-to-handle-inappropriate-nicknames
9. Player identifier: https://support.kahoot.com/hc/en-us/articles/360036178314-Player-identifier
10. How to host a live kahoot: https://support.kahoot.com/hc/en-us/articles/360039422694-How-to-host-a-live-kahoot
11. See questions on participant's screen: https://support.kahoot.com/hc/en-us/articles/115003197928-How-to-enable-See-questions-on-participant-s-screen-in-Kahoot-live-games
12. How many participants can play a kahoot?: https://support.kahoot.com/hc/en-us/articles/115003072287-How-many-participants-can-play-a-kahoot
13. Guide for one-time events: https://support.kahoot.com/hc/en-us/articles/11166126591891-Guide-for-one-time-events
14. Kahoot! At Work: How many participants can play a kahoot?: https://support.kahoot.com/hc/en-us/articles/33995887450899-Kahoot-At-Work-How-many-participants-can-play-a-kahoot
15. How to use word cloud: https://support.kahoot.com/hc/en-us/articles/26507460634003-Kahoot-questions-How-to-use-word-cloud
16. How to use open-ended questions: https://support.kahoot.com/hc/en-us/articles/26630693428883-Kahoot-questions-How-to-use-open-ended-questions
17. How to use pin answer question: https://support.kahoot.com/hc/en-us/articles/27330153231635-Kahoot-questions-How-to-use-pin-answer-question
18. How to brainstorm with Kahoot!: https://support.kahoot.com/hc/en-us/articles/26303497051027-Kahoot-questions-How-to-brainstorm-with-Kahoot
19. How to use scale and NPS scale: https://support.kahoot.com/hc/en-us/articles/26882614481427-Kahoot-questions-How-to-use-scale-and-NPS-scale
20. Team experience: How to play kahoot in groups: https://support.kahoot.com/hc/en-us/articles/4408679135891-Team-experience-How-to-play-kahoot-in-groups
21. Rematch experience (Play again with ghosts): https://support.kahoot.com/hc/en-us/articles/115000510968-Rematch-experience-Play-again-with-ghosts
22. Kahoot! experiences: https://support.kahoot.com/hc/en-us/articles/35636870654867-Kahoot-experiences
23. Accuracy experience: https://support.kahoot.com/hc/en-us/articles/39818967108627-Accuracy-experience-How-to-host-a-kahoot
24. Confidence experience: https://support.kahoot.com/hc/en-us/articles/32200674639261-Confidence-experience-How-to-host-a-kahoot
25. How to assign a kahoot in web platform: https://support.kahoot.com/hc/en-us/articles/360039411334-How-to-assign-a-kahoot-in-web-platform
26. Tips for hosting a live game: https://support.kahoot.com/hc/en-us/articles/360039900153-Tips-for-hosting-a-live-game
27. Kahoot! quiz reports: https://support.kahoot.com/hc/en-us/articles/360035063054-Kahoot-quiz-reports
28. How to download and use spreadsheet reports: https://support.kahoot.com/hc/en-us/articles/360035547493-How-to-download-and-use-spreadsheet-reports
29. Guide to Kahoot! reports API: https://support.kahoot.com/hc/en-us/articles/11735948502931-Guide-to-Kahoot-reports-API
30. Unplugged experience: https://support.kahoot.com/hc/en-us/articles/38672366832669-Unplugged-experience-How-to-host-a-kahoot-without-participant-devices

Kahoot help-centre community forum (tag [secondary-community]; user-written; mostly titles/snippets):

31. Disable Answer Streak Bonus: https://support.kahoot.com/hc/en-us/community/posts/360033686653-Disable-Answer-Streak-Bonus
32. PLEASE reinstate option to toggle off points: https://support.kahoot.com/hc/en-us/community/posts/360033637653-PLEASE-reinstate-option-to-toggle-off-points
33. Option to show/hide leaderboards between questions: https://support.kahoot.com/hc/en-us/community/posts/115001072628-Option-to-show-hide-leaderboards-between-questions
34. Let players change answer before time is over: https://support.kahoot.com/hc/en-us/community/posts/115001072948-Let-players-change-answer-before-time-is-over
35. "Allow Rejoin" Option: https://support.kahoot.com/hc/en-us/community/posts/38694866852243--Allow-Rejoin-Option
36. Rejoining: https://support.kahoot.com/hc/en-us/community/posts/28689030850963-Rejoining
37. Ability to customize or disable the countdown music: https://support.kahoot.com/hc/en-us/community/posts/115001072588-Ability-to-customize-or-disable-the-countdown-music ; Turn the Music OFF: https://support.kahoot.com/hc/en-us/community/posts/360043835633-Turn-the-Music-OFF
38. Reveal correct answer after each question of all devices: https://support.kahoot.com/hc/en-us/community/posts/34484931017629-Reveal-correct-answer-after-each-question-of-all-devices ; showing the correct answer at the end of the "answering time": https://support.kahoot.com/hc/en-us/community/posts/26708301497491-showing-the-correct-answer-at-the-end-of-the-answering-time

Third-party (tag [secondary]):

39. unixpickle/kahoot-hack issue #86 (fetched directly): https://github.com/unixpickle/kahoot-hack/issues/86
40. unixpickle/kahoot-hack README (fetched directly; "nicknames are limited to 15 characters"): https://github.com/unixpickle/kahoot-hack/blob/master/README.md
41. robots.net, "How Many Numbers Are There In A Kahoot Pin" (six digits): https://robots.net/tech/how-many-numbers-are-there-in-a-kahoot-pin/ ; "How Many Characters In Kahoot Name" (15 characters): https://robots.net/tech/how-many-characters-in-kahoot-name/
42. theusaf/kahoot.js-updated README (fetched directly; example with a 7-digit PIN): https://github.com/theusaf/kahoot.js-updated

Located but not read (blocked): Kahoot blog posts on nicknames https://kahoot.com/blog/2017/11/09/generate-funny-nicknames-players-live-kahoots/ and https://kahoot.com/blog/2019/03/08/tips-keep-kahoot-nicknames-appropriate/.

43. Kahoot pricing pages (located in search; content via summary): https://kahoot.com/register/pricing-events/ , https://kahoot.com/business/pricing/ , https://kahoot.com/schools/plans/
44. Community: Time Increments https://support.kahoot.com/hc/en-us/community/posts/24065894690835-Time-Increments ; Allow more time limit options https://support.kahoot.com/hc/en-us/community/posts/36700429553555-Allow-more-time-limit-options
45. Community: Offer QR code that is active for 8 hours: https://support.kahoot.com/hc/en-us/community/posts/36157817948051-Offer-QR-code-that-is-active-for-8-hours-so-I-can-print-it-for-my-event
