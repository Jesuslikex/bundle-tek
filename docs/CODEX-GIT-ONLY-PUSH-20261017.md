# Git-only main push

The user requested pushing all committed main work to GitHub without deploying.

Before pushing, the Vercel API confirmed bundle-tek (prj_Fy1IRrsW0JQIpIUoRezo4ttgHZXS) is now connected to Jesuslikex/bundle-tek with productionBranch main and gitProviderOptions.createDeployments enabled. Therefore merely omitting the deploy command would not preserve the user's boundary.

Added vercel.json with git.deploymentEnabled false, the documented repository configuration for disabling Git-triggered deployments. This leaves explicit manual deployment available. No environment, provider, credential, cron, migration or application behavior is changed. Source before this configuration commit: 9ce8de7, including the warmup self-review and merged Desktop browser verification notes.

Verification: parsed the JSON and checked the exact false value, checked formatting and Git whitespace, and confirmed no repository GitHub workflows or active local push hooks. Push is a normal fast-forward to origin/main only. No legacy or CROP push and no deployment command.

Reference: https://vercel.com/docs/project-configuration/git-configuration
