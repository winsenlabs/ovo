# Dependency license review

Inspected 2026-09-20 from installed package metadata and relevant license files. [Inventory](dependency-licenses.json) records names, versions, reported licenses and the lockfile digest. Regenerate the inventory after dependency changes. This is an engineering inventory, not a legal opinion or distribution approval.

## Source reuse

The actual DeepSeek/Cordis/Cosmokit source notices and MIT licenses ship with OVO's runtime bundle. See [import map](deepseek-import-map.md) and `THIRD_PARTY_NOTICES.md`.

## Non-permissive and mixed-license dependencies

| Dependency                           | License/obligation                                                                                                                                                         | Decision                                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@livekit/local-inference` 0.2.7     | Apache-2.0 **and** `LicenseRef-LiveKit-Model`. The installed `MODEL_LICENSE` restricts models to LiveKit Agents and prohibits using model outputs to develop other models. | Comparative experiment only. Do not extract weights/inference code into the focused OVO engine. No production approval follows from the parent SDK's Apache license. |
| `@livekit/av-linux-x64`              | LGPL-2.1-or-later native audiovisual dependency                                                                                                                            | Comparative experiment only. Any redistributed image needs corresponding LGPL compliance and notice review.                                                          |
| `@img/sharp-libvips-*`               | LGPL-3.0-or-later                                                                                                                                                          | Transitive Next.js image dependency. Retain libraries/notices and review redistribution obligations before publication.                                              |
| `lightningcss` and platform binaries | MPL-2.0                                                                                                                                                                    | Next.js build dependency. Retain notices and source obligations for modified covered files. OVO does not modify these files.                                         |
| `caniuse-lite`                       | CC-BY-4.0                                                                                                                                                                  | Build-time browser compatibility dataset; preserve attribution.                                                                                                      |

LiveKit comparative dependencies are not selected production worker capabilities. The workspace install contains research tooling; a production artifact must separate that tooling and its transitive native/model files from deployed components. Package publication and paid deployment remain unauthorized.

The remaining installed inventory primarily uses MIT, Apache-2.0, BSD, ISC and other permissive SPDX expressions. Review the actual dependency set in each final distribution, not only the aggregate development install. Do not describe the complete dependency closure as MIT-only.

## Audit checkpoint

The local production dependency audit reports **zero advisories** after upgrading AWS SDK packages to `3.1136.0` and Ajv to `8.20.0`. This is a point-in-time registry check, not proof that software is vulnerability-free. The final local gate reruns the audit against the frozen lockfile.
