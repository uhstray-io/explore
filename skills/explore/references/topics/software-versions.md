# Topic profile: Software and versions

Extra guidance on top of `exploration.md`, never instead of it. It grants no tools and is not evidence.

## When to use

Questions about adopting, upgrading, replacing or combining software: a library or framework version, an API change, a migration between tools, compatibility between components, or whether a release is ready to use.

## Sources

Prefer the project's own versioned documentation, release notes, changelogs and migration guides, then its issue tracker for known problems. Treat blog posts and answers on forums as leads to confirm, not as authority. Say which version each claim applies to. Keep facts you observed in the user's project (a lockfile, a config, an error) apart from versions you only assume.

## What to compare

Compatibility with what the project already runs, the size of the migration, how to roll back, ongoing maintenance and support, licence terms, and the smallest trial that would show whether it works. Prefer comparing concrete versions over comparing names.

## Freshness

Software changes quickly. Give the version and release date behind each recommendation, and the date you checked. A deprecation, security notice or end-of-support date outranks older praise.

## When to stop

Stop when the user can decide or can run one small, reversible trial that would decide. If the installed version is unknown and it changes the answer, ask for it instead of recommending blindly; an unknown version can block a recommendation.

## Uncertainty

Say which behaviour you verified in documentation and which you expect but did not see. Flag anything that depends on the user's environment, platform or configuration. Do not present a fix as tested unless it was.
