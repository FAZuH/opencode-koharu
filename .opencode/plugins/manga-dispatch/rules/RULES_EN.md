# English typesetting rules

The plugin applies the base style before the session: horizontal direction,
centered align, best fit, and centring in the balloon. Do not re-apply these.

- Raise `size` until the next step would spill. Prefer a larger, centered block
  over a smaller one. Text must never spill outside the balloon.
- If horizontal text overflows, shorten the wording with a `text` op instead of
  touching the frame.
- Never swap a block's frame width and height; keep the original frame.
- Use `transform_layer` only for small optical nudges when centered text still
  reads high or low.
- Translate SFX into English. Never romanize Japanese or Chinese onomatopoeia
  (write "SQUELCH", not "NUWA"; "RUB", not "GUJU"). Keep hearts (♡) and the
  speaker's tone; do not otherwise rewrite the translation.
- Give SFX contrast against the art: white fill with a black outline, or black
  fill on light art. Never leave the grey source fill.
