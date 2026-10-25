-- Kanji Ladder database. Paste this whole file into Supabase → SQL Editor → Run. Safe to run again.

-- Your progress: one row per account
create table if not exists public.progress (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  level      int  not null default 1,
  started    bigint,
  kanji      jsonb not null default '{}'::jsonb,   -- { "一": [stage, nextReviewHour], ... }
  vocab      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Daily stories (the log book): one per account per day
create table if not exists public.stories (
  user_id    uuid not null references auth.users(id) on delete cascade,
  date       text not null,                         -- YYYY-MM-DD in your time zone
  data       jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, date)
);

-- Memory hooks, shared by everyone signed in to this app
create table if not exists public.hooks (
  id         text primary key,                      -- "u" + code point(s) of the kanji
  kanji      text not null,
  text       text,
  updated_at timestamptz not null default now()
);

alter table public.progress enable row level security;
alter table public.stories  enable row level security;
alter table public.hooks    enable row level security;

drop policy if exists "own progress" on public.progress;
create policy "own progress" on public.progress for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own stories" on public.stories;
create policy "own stories" on public.stories for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "read hooks" on public.hooks;
create policy "read hooks" on public.hooks for select to authenticated using (true);
drop policy if exists "add hooks" on public.hooks;
create policy "add hooks" on public.hooks for insert to authenticated with check (true);
drop policy if exists "edit hooks" on public.hooks;
create policy "edit hooks" on public.hooks for update to authenticated using (true) with check (true);

grant select, insert, update, delete on public.progress, public.stories to authenticated;
grant select, insert, update on public.hooks to authenticated;

-- Memory hooks written so far
insert into public.hooks (id, kanji, text) values
  ('u4e00', '一', 'A single horizontal stroke, like **one** finger held sideways.'),
  ('u4e09', '三', 'Three horizontal lines with the middle one shortest: **three**.'),
  ('u4e0a', '上', 'A stick rising from the ground line, pointing **up**. Its opposite 下 hangs down below the line.'),
  ('u4e2d', '中', 'A box (口) skewered by one line straight through the **middle**.'),
  ('u4e5d', '九', 'Looks like 力, but the right stroke curls outward into a tail. A cat curling its tail around the number **nine**.'),
  ('u4e8c', '二', 'Two horizontal lines, the bottom one longer: **two**.'),
  ('u4e94', '五', '二 with a zigzag squeezed between its lines, making a small box in the middle: **five**.'),
  ('u4eba', '人', 'Two strokes leaning together like walking legs: a **person** striding along. In 入 (enter) the right stroke sits on top instead.'),
  ('u5165', '入', '人 flipped: the right stroke is on top and the left one slides in underneath, like ducking through a doorway to **enter**.'),
  ('u51fa', '出', 'Two 山 (mountain) shapes stacked, one poking up over the other to get **out**. An exit sign in kanji.'),
  ('u5206', '分', '八 (two strokes splitting apart) over 刀 (a **sword**): the blade **divides** something in two. Also used for minutes.'),
  ('u529b', '力', 'A flexed arm: the hooked stroke is the bicep, the slash is the forearm. **Power**! Unlike 九, the right side drops straight down with no curl.'),
  ('u5341', '十', 'A plus sign, one line across and one down. Cross your two hands, all **ten** fingers out.'),
  ('u5927', '大', 'A 人 (person) with arms stretched wide across the top, showing you how **big** the fish was.'),
  ('u5b50', '子', 'A swaddled baby: a hook for the body, one line across for little arms. A **child**.'),
  ('u624b', '手', 'Picture 手 as a **hand** with a long wrist: three horizontal lines are fingers, and one vertical stroke curving at the bottom is the arm. Imagine a waving **hand** reaching up from a sleeve, fingers spread, to grab the **て** (te) of a friend and shake it.'),
  ('u65e5', '日', 'A box with one line across the middle, a window with the **sun** shining in. 目 (eye) is taller, with two lines inside.'),
  ('u6708', '月', 'Like 日 but open at the bottom, with a sweeping left leg and two lines inside: a crescent **moon** hanging in its frame. It also means month.'),
  ('u672c', '本', '木 (tree) with a short line marking the base of the trunk: the **root** or origin. Trees also become paper, so it means **book**.')
on conflict (id) do nothing;
