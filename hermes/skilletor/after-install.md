# skilletor

The plugin runs the **skilletor CLI** (Node.js >= 18): `$SKILLETOR_BIN`, else `skilletor`
on `PATH`. Without one it does nothing. skilletor's `install.sh` puts one into
`~/.local/bin` (https://github.com/Getty/skilletor#from-the-command-line); name it, or the
`bin/skilletor` of a clone, in the Hermes home's `.env` (`~/.hermes/.env` by default):

    SKILLETOR_BIN=/home/you/.local/bin/skilletor

or leave `.env` alone when `~/.local/bin` is on Hermes' `PATH`.

Hermes is never detected: add `"hermes"` to the `targets` of `~/.claude/skilletor.json`.
Not enabled yet: `hermes plugins enable skilletor`. Check: `hermes skilletor status`.
