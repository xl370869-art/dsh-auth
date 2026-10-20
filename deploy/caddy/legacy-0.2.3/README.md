These two immutable templates are copied from the published npm package
`dsh-auth@0.2.3`, the image upgrade baseline. They are used only to validate or
restore the exact managed configuration of that release. New installations and
successful upgrades use the current templates one directory above.

Do not relax drift checking or generate new installations with these templates.
The native DSH authentication bridge environment flag was absent in 0.2.3 and is
likewise omitted only when validating/restoring that exact recorded version.
