# The default pet

`pet.png` (the figure) and `pet-silhouette.png` (the same figure, dark) are
cut out from a widely shared internet meme. They are not the project's own
work, and the licence of this repository does not apply to them.

The server shows them when the pet is turned on in Settings and the operator
has not set `ALDINE_INSTANCE_PET`. To use another image, point
`ALDINE_INSTANCE_PET` (and optionally `ALDINE_INSTANCE_PET_SILHOUETTE`) at a
still PNG, WebP or SVG of at most 512 KB; set `ALDINE_INSTANCE_PET=none` to
have no pet at all.

## The squeak

Clicking the pet plays a squeak. With no recording the app synthesizes a
rubber-duck squeak itself. To use a recording instead, drop `squeak.mp3`,
`squeak.ogg` or `squeak.wav` (at most 512 KB) in this folder and restart the
server: it is served at `/api/instance/pet/squeak` to signed-in people, and
the app plays it with a little speed variation on every click. No code change
is needed. `ALDINE_INSTANCE_PET_SQUEAK` names a file elsewhere, and
`ALDINE_INSTANCE_PET_SQUEAK=none` keeps the synthesized squeak even when a
file is here.
