# Family Grocery List

One shared grocery list for the whole family. When anyone adds, checks off, edits or deletes an item, it shows up on every other phone within about a second. Nobody has to refresh.

- Works in any phone or computer browser. Use "Add to Home Screen" to make it look like an app.
- Shows who added each item and who got it ("Added by Mom", "Got by Riya").
- Groups items by aisle (Produce, Dairy, and so on). Checked items move to "In the cart".
- Highlights items that someone else just changed.
- A family code keeps strangers out.
- No dependencies: plain Node.js 18 or newer. There is nothing to `npm install`.

## Run it

```bash
FAMILY_CODE=pick-a-code node server.js
# open http://localhost:3000
```

| Setting       | Default            | What it does                                          |
|---------------|--------------------|-------------------------------------------------------|
| `FAMILY_CODE` | *(empty)*          | Code each person types once. If it is empty, anyone with the link can edit. |
| `PORT`        | `3000`             | Port the server listens on.                           |
| `DATA_FILE`   | `./data/list.json` | Where the list is saved.                              |

## Getting it onto everyone's phones

Every device has to reach the same server. Pick one of these:

1. **Same Wi-Fi only (free, simplest):** run it on a computer that stays on at home. Family members open `http://<that-computer's-IP>:3000`. The list only works while they are on the home Wi-Fi, so it **won't work in the store** unless you add the next option.
2. **Home computer + tunnel (free, works anywhere):** keep option 1 running and expose it with Tailscale (private to the family) or Cloudflare Tunnel (public URL). Tailscale is the safer of the two.
3. **Cloud host (works anywhere, no home computer):** deploy the included `Dockerfile` to a host that offers a **persistent disk/volume**, for example Fly.io or Railway. Mount the volume at `/data`.
   - ⚠️ Free tiers without a persistent disk (such as Render's free web service) erase `list.json` on every restart, so you lose the list. Don't use them without a volume.

Use HTTPS (options 2 and 3 give you this) when you set a family code. Otherwise the code is sent in plain text.

## How syncing works

- The server holds the one true list and saves it to `DATA_FILE`.
- Phones send small changes ("add Milk", "check item X"), never the whole list. So if two people tap at the same moment, both changes are kept.
- The server pushes the updated list to every open phone using Server-Sent Events. If a phone loses signal, it reconnects on its own and catches up.

## Limits (read these)

- **No offline editing.** With no signal (some supermarkets), you can still read the list, but changes are rejected with an "offline" message. They are not queued for later.
- The family code is shared, not a per-person login. Names are self-reported.
- Single server process. That is plenty for a family, but don't run several copies behind a load balancer.

## Tests

```bash
npm test
```

The tests cover live sync between two connected clients, simultaneous adds, edit/delete/clear, input validation, the family-code check and saving to disk.
