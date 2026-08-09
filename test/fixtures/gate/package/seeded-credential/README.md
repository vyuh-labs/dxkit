# generated package (credential seed injected at test time)

The acceptance test writes a scannable credential into `code/service.js`
in its scratch copy before gating. The committed fixture carries no
credential bytes, so dxkit's own repo gate stays clean.
