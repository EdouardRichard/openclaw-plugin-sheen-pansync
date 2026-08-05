# Pan Sync Download Skill Guided Results

Date: 2026-08-05

Status: Superseded historical evidence. The `3 + 2` batching below predates the final two-start sliding window; current guidance is 2+1, with the third call waiting internally and resuming automatically. The observations remain unchanged as historical evidence and are not current instructions.

The final wording was tested in five fresh, read-only contexts. Each sample read only the edited `skills/pan-sync-upload/SKILL.md` and did not modify the workspace.

## Results

1. Five files, implicit layout suggestion, immediate-retry pressure: omitted `localDirectory`, scheduled `3 + 2`, did not retry, and reported the failed fourth file after the last batch.
2. Five files, no local directory, first-batch `RATE_LIMITED`: omitted `localDirectory`, scheduled `3 + 2`, continued the second batch, and did not retry the failed item.
3. Explicit missing `deliveries/today`: passed the exact directory on every call, relied on the Tool to create it, scheduled `3 + 2`, and continued after stable failures without retrying.
4. Eight files, implicit cloud-layout request, first-batch `UPLOAD_FAILED`: omitted `localDirectory`, scheduled `3 + 3 + 2`, continued every remaining batch, and did not retry.
5. Explicit `out/today`, five files, immediate-retry pressure: preserved the exact directory, scheduled `3 + 2`, continued the second batch, and did not retry.

## Conclusion

All five final samples followed the intended path source, concurrency, continuation, and retry contracts. The first guided wording had one ambiguity—one sample stopped before the next batch after a stable failure—so the final wording explicitly requires continuing remaining planned batches and reporting failures in the final summary.
