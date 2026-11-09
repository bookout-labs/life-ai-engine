---
name: sunday
description: Sunday procedures for the personal operating system.
---

Run `node .agents/scripts/weekly.ts` for preparation data from Neon. It defaults to the next Monday, including today when today is Monday. Pass a start date as YYYY-MM-DD to reproduce another week. The JSON includes a seven-day schedule and bills, fourteen days of deadlines plus overdue items, members, relationships, active activities, and loan balances as of the start date. Undated deadlines and obligations without a billing day have separate lists. Empty lists mean no matching records. Null amounts or balances mean unknown. Unavailable summaries are listed explicitly. The command reads records in one read-only snapshot.

Read current weekly and areas pages through pages.ts for household check-in preferences, routine, decisions and questions. Use the command's records for commitments and money due. Do not extract record tables from prose pages or treat missing spending, training or investment history as zero. Report unavailable sources privately. Prepare a short dashboard, write weekly/<date> through pages.ts and update the huddle data through its connected storage. Scheduled preparation may read connected sources and write private pages. Sending email requires an explicit current authorization and recipients read from private settings. Never embed recipients or household names in this procedure.
