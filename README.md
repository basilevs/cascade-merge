# Usage example
```yaml
name: Cascade Handler

on:
  workflow_run:
    workflows: ["Verify branch"] # The 'Original Workflow'
    types: [completed]

jobs:
  cascade:
    runs-on: ubuntu-latest
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Important for merge history

      # Step 1: Execute the Merge Action (Main Phase)
      # This creates local branches merge/release/1.0/release/1.1 etc.
      - name: Calculate and Merge
        id: cascade
        uses: ./path/to/action # or owner/repo@v1
        with:
          token: ${{ secrets.PAT_TOKEN }} # Use PAT to trigger downstream workflows
          dependency_graph: |
            release/1.0: release/1.1 experiment4
            release/1.1: release/1.2
            release/1.9: release/2.0 feature11

      # Step 2: Intermediate Actions (Filter unwanted changes)
      # NOTE: If you have multiple downstreams, this script must be smart enough
      # to switch between the branches created by the step above.
      - name: Remove Version Bumps (Intermediate)
        run: |
          # The action sets the last processed branch as active.
          # If we need to process ALL temp branches, we must loop manually.
          # This example assumes the Action outputted the branches or we know logic.
          
          # Example Logic:
          CURRENT_BRANCH=$(git branch --show-current)
          if [[ "$CURRENT_BRANCH" == merge/* ]]; then
             echo "Sanitizing $CURRENT_BRANCH..."
             # Remove pom.xml changes if they exist in diff (simplified logic)
             git checkout origin/$(echo $CURRENT_BRANCH | cut -d/ -f3) -- pom.xml || true
             
             # Commit cleanup if changed
             git diff --quiet || git commit -am "Revert release management files"
          fi

      # Step 3: The 'Post' phase of the cascade action runs automatically here.
      # It will push the branches and create PRs.
```