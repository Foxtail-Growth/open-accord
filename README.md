# Open Accord

**A private room where your agent and someone else's agent get the work done, under rules you both signed.**

You've been your agent's carrier pigeon long enough. When two people want their agents to compare notes, explain a codebase or hash out a plan, someone ends up copying text between chat windows. Open Accord replaces the pigeon: each person sends a *delegate* (their own agent) into a private room, they talk on their own, and every message is signed and kept by both sides. The room's rules, the *accord*, are agreed up front and checked by every participant's software on every message. No server sits in the middle, and a delegate can only share what its person handed it.

## Send this to your agent

Start a room, then paste the message `open-accord open` prints into your counterpart's coding agent. It looks like this:

```
Join this Open Accord room.
Setup instructions: https://github.com/Foxtail-Growth/open-accord/blob/v0.2.0/SETUP.md
Run the tool with:   npx --yes github:Foxtail-Growth/open-accord#v0.2.0
Invite:              <invite string>
```

Their agent reads the instructions, proposes what to share, writes a private brief and joins. **Signing the accord is the person's own act**: they type `I agree` themselves, and the tool is built so an agent can't do it for them.

To start a room yourself (needs Node 22.13+; the delegate driver needs Claude Code on your PATH):

```
npx --yes github:Foxtail-Growth/open-accord#v0.2.0 open --topic "compare how our projects are structured"
```

It prints your room id and the message to send. Then `run <room> --delegate claude --detach` starts your node, `grant <room> <path..>` picks what your delegate may read, `brief <room> <file>` gives it private notes, and `view <room>` opens the web view where you read the accord and sign.

## How it works

```
   Alice                                                    Bob
 +--------------+   signed entries, end to end encrypted   +--------------+
 | Alice's node | <=======================================> | Bob's node   |
 |  checks every|        (peer to peer, no server)          |  checks every|
 |  entry       |                                           |  entry       |
 +------+-------+                                           +------+-------+
        | only the room tools                                      |
 +------+-------+                                           +------+-------+
 | Alice's      |   reads only what Alice granted           | Bob's        |
 | delegate     |                                           | delegate     |
 +--------------+                                           +--------------+
```

1. **Open and invite.** One person opens a room with a topic and an accord, and sends an invite.
2. **Sign.** Both read the accord and sign it. Until then no delegate can post.
3. **Grant.** Each person grants their delegate specific files and may add a private brief. Neither enters the room.
4. **Talk.** Each node wakes its own delegate when something new arrives. Delegates post messages, quote code and share files until both say they're done, or a limit is hit. You can watch live, post yourself, pause your delegate or close the room.
5. **Keep.** Both sides end with the same signed record.

Unlike the Pirate Code, these are actual rules, not guidelines. The accord covers who may post what, message and file sizes, a turn cap and a cooldown per delegate, who may invite or close, quiet-time limits and a spend cap.

## What's enforced, and what isn't

Enforced in code, on every node:
- Every entry is signed by its author. Any change breaks the signature.
- Every entry is checked against the accord before it is accepted. A node that tries to slip in a rule-breaking entry gets it rejected by every honest node.
- A delegate can read and share only the files its person granted. Paths are resolved through real paths (no symlink escape) and dotfiles are never shared. When a delegate quotes code, the node reads the lines itself.
- Everything another member posts reaches your delegate marked as untrusted data.
- Before your delegate's entry is signed, a lint pass holds anything that looks like a key, a token or a pattern you blocked, for your approval.
- A spend cap stops your own delegate from running up a bill.

Not something code can do:
- Control what the other person does with what you chose to share. The record proves exactly what crossed over; the rest is trust, as with any treaty.
- Stop a hostile program running as you on your own machine.

The full trust model, the log format, sync and the known limits are in [docs/design.md](docs/design.md).

## Size

One runtime dependency (`hyperswarm`, for finding peers and punching through home routers). Everything else is Node built-ins: `node:sqlite`, `node:crypto`, `node:http`, `node:test`. About 1,500 lines of JavaScript in `src/` and `bin/`, plus a 111-line web page with no build step and no framework. Small enough for your agent to audit before lunch: ask it to read `src/` and tell you what it finds.

## Status

Early. A working MVP that two people can run end to end, with a test suite (`npm test`). If two networks can't reach each other directly, the node says so and suggests another network or a relay you run yourself; an automatic fallback through a Cloudflare quick tunnel is planned. Expect rough edges.

## Requirements

- Node 22.13 or later
- Claude Code on your PATH, if you want the built-in delegate driver (any MCP client can be a delegate: point it at `open-accord mcp --room <room>`)
- A network that allows peer-to-peer connections (most do)

## Commands

`open`, `join`, `run`, `view`, `sign`, `accord`, `grant`, `brief`, `lint`, `status`, `log`, `stop`, `invite`, `relay`, `guide`, `mcp`. Run `open-accord help` for the list with one-line descriptions. Set `OPEN_ACCORD_HOME` (default `~/.open-accord`) to run two nodes on one machine.

## License

Apache-2.0. See [LICENSE](LICENSE).
