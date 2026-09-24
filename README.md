# Claude Usage Dashboard

A local dashboard for monitoring Claude plan limits and understanding which
sessions and models account for activity over a selected time range.

<img width="1506" height="834" alt="image" src="https://github.com/user-attachments/assets/08d407cd-bb01-4266-8cd0-636258c89f78" />


## What it reads

- `~/.claude/projects/**/*.jsonl`: metadata, timestamps, model names, and token
  counters only. Prompts, responses, and tool calls are neither persisted by
  the dashboard nor sent to the browser.
- `~/.claude/.credentials.json`: the OAuth token stays in the local server
  process and is used exclusively to request
  `https://api.anthropic.com/api/oauth/usage`. The token is never included in
  the dashboard's HTTP responses.

Plan utilization and reset times are official values returned by Anthropic.
The local token counters are diagnostic activity measurements; they are not an
exact breakdown of plan utilization because Anthropic does not publish the
quota weighting formula.

## Run locally

The dashboard requires Python 3.10+ and has no third-party dependencies.

```bash
python3 app.py
```

Open <http://127.0.0.1:8787>. The first load may take a few seconds while the
history is indexed after clicking **Sync now**. Opening or reloading the page
only reads the existing index and in-memory quota cache, without contacting
Anthropic or scanning JSONL files. After a server restart, use **Sync now** to
populate the quota cache.

Automatic synchronization defaults to every 5 minutes while the page is open.
Choose 5, 10, 15, or 30 minutes, or manual-only mode; the browser remembers the
selection. Changing the interval does not immediately sync. **Sync now** bypasses
the normal five-minute quota cache, but respects the error cooldown. Failed
requests wait at least five minutes before retrying; numeric `Retry-After`
headers can extend this wait. Multiple tabs share the server quota cache.
The displayed official timestamp records the last successful quota fetch.

Options:

```bash
python3 app.py --port 9000
python3 app.py --claude-dir /another/path/.claude
```

For safety, the server binds to `127.0.0.1` by default. Do not expose it to a
network without adding authentication.

## Security and privacy

- The SQLite database, generated profile, caches, and environment files are
  ignored by Git.
- The OAuth token is read into memory and sent only to `api.anthropic.com`.
- The OAuth usage endpoint is internal and undocumented, so it may change
  without notice. The dashboard reports failures without exposing credentials.
- Review the code before changing the bind address to a network interface.

## Historical pace profile

Generate or refresh the personal usage curve with:

```bash
python3 build_usage_profile.py --timezone America/Sao_Paulo
```

Choose your own IANA timezone (the default is UTC). The script fetches the
account-wide weekly reset from the authenticated account; no weekday or hour
is hardcoded. If the reset cannot be retrieved, it fails with instructions for
an explicit manual override rather than assuming a schedule:

```bash
python3 build_usage_profile.py --timezone Europe/London --reset-weekday 2 --reset-hour 14 --reset-minute 30
```

Weekdays use 0=Monday through 6=Sunday. The override configures historical
training only; official reset times and utilization always come from the API.

The script aggregates up to 90 days of completed cycles into 168 hourly slots.
It excludes the
current cycle to avoid training on the period being evaluated. Recent weeks
receive more weight through a 28-day half-life.

The aggregate is written to `.cache/usage-profile.json`. It contains no
conversation content, project names, or session identifiers. The dashboard
uses this curve for the weekly pace calculation and falls back to a linear pace
when no profile exists. Refreshing the profile once a week is recommended.

The weekly pace selector offers two modes, saved in the browser:

- **Historical profile** (default): uses the original hourly weights.
- **Balanced Monday–Friday**: averages each clock hour across the five workdays
  and assigns that average to each workday. Each workday therefore receives
  one fifth of the combined workday share, while retaining the average intraday
  pattern. Every Saturday and Sunday slot remains unchanged, as does the weekly
  total. This is a planning assumption, not inferred unmet demand or automatic
  outlier detection.

The selected mode applies to the expected weekly curve, pace indicators, and
weekly projections. It does not change official utilization, the observed usage
curve, or the five-hour session calculation. No profile rebuild is needed to
switch modes.

The browser aligns the profile's calendar-hour weights to each official weekly
window, including model-specific windows and resets that change day or time.
Minute offsets are interpolated at the profile's hourly resolution. Reset dates
in the cards use the browser's timezone; workday patterns use the profile's
configured timezone. The fixed 168-hour model approximates weeks spanning a
daylight-saving transition.

## Metrics

The interface deliberately separates two kinds of data:

- **Official plan utilization:** the percentage and reset time reported by the
  Anthropic OAuth usage endpoint. This is the source of truth for quota usage.
- **Local activity counters:** token fields recorded in Claude Code JSONL logs.
  They explain the shape and distribution of local activity, but cannot be
  converted exactly into plan percentage.

Local counters shown together in the dashboard:

- **Input:** uncached input tokens reported in `input_tokens`.
- **Output:** generated tokens reported in `output_tokens`.
- **Cache writes:** input tokens written to the prompt cache, reported in
  `cache_creation_input_tokens`.
- **Cache reads:** input tokens reused from the prompt cache, reported in
  `cache_read_input_tokens`.
- **Thinking:** reasoning tokens reported in
  `output_tokens_details.thinking_tokens`. This is a detail of output, not an
  additional value to add to the totals.
- **Profile basis:** input + output + cache writes. This derived value is used
  to reconstruct the current weekly curve and train the historical profile.
- **Processed volume:** profile basis + cache reads. This is useful as a measure
  of total context handled, but large cache reads can make it much larger than
  the amount of new work or the official quota percentage.

Repeated streaming log entries are deduplicated by session and `message.id`.
