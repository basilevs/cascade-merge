# Usage example
```yaml
name: Cascade Merge

on:
  workflow_run:
    workflows: ["Verify branch"] # The 'Original Workflow'
    types: [completed]

jobs:
  cascade:
    permissions:
      pull-requests: write
      contents: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.PAT_TOKEN }} # To trigger downstream workflows after push
          fetch-depth: 0 # Important for merge history

      # Step 1: Execute the Merge Action (Main Phase)
      # This creates local branches merge/release/1.0/release/1.1 etc.
      - name: Merge upstream to downstreams in temporary branches
        id: cascade
        uses: ./path/to/action # or owner/repo@v1
        with:
          token: ${{ secrets.PAT_TOKEN }} # Used to create a PR, optional
          dependency_graph: |
            release/1.0: release/1.1 experiment4
            release/1.1: release/1.2
            release/1.9: release/2.0 feature11

      # Step 2: Intermediate Actions (Filter unwanted changes)
      # NOTE: If you have multiple downstreams, this script must be smart enough
      # to switch between the branches created by the step above.

      - name: Reject version bumps
        if: steps.cascade.outputs.target_branches_list != ''
        run: |
          echo "${{ steps.cascade.outputs.target_branches_list }}" | while read -r downstream; do
            # Consider a change to pom.xml to be a version bump and reject the merge
            git diff --name-only --merge-base "origin/$downstream" "${{ github.event.workflow_run.head_sha }}" | grep pom.xml$ && exit 2 || true
          done

      # Step 3: The 'Post' phase of the cascade action runs automatically here.
      # It will push the branches and create PRs if all steps above succeed.
```