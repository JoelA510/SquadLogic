# Schedule import preview under safe updates

The owner approved this repair after both hosted import panels accepted and mapped synthetic rows, then stopped before preview. With PostgreSQL's safe-update library loaded locally, the same operations failed on their temporary work tables.

Game imports classify pending rows and mark a TIME TBD row for conversion only when it matches a movable saved game. Practice imports mark a group as occupied only when an accepted placement uses that group. Keep these decisions in the existing job transactions and preserve the preview confirmation, Published and scored-game protections, rollback guards, and tenant checks.

Run both existing apply-and-rollback pgTAP suites with safe updates active. Verify the prior definitions fail at preview, verify the replacement definitions and guarded revert, then repeat both imports through the hosted UI after CI deploys the change.
