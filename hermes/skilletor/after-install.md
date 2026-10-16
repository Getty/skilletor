# skilletor

The plugin runs the **skilletor CLI** (Node.js >= 18): `$SKILLETOR_BIN`, else `skilletor`
on `PATH`. Without one it does nothing. For a clone of https://github.com/Getty/skilletor,
name its launcher in the Hermes home's `.env` (`~/.hermes/.env` by default):

    SKILLETOR_BIN=/home/you/src/skilletor/bin/skilletor

Hermes is never detected: add `"hermes"` to the `targets` of `~/.claude/skilletor.json`.
Not enabled yet: `hermes plugins enable skilletor`. Check: `hermes skilletor status`.
