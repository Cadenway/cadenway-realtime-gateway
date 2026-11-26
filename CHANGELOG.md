# Changelog

## [0.4.0](https://github.com/Cadenway/cadenway-realtime-gateway/compare/v0.3.0...v0.4.0) (2026-11-26)


### Features

* **realtime:** add presence snapshot and personal notices ([#32](https://github.com/Cadenway/cadenway-realtime-gateway/issues/32)) ([ac6a6d5](https://github.com/Cadenway/cadenway-realtime-gateway/commit/ac6a6d54ed23ea735bca8bc912b296ad517c54ea))
* **realtime:** authorize ticketed rooms and relay private task events ([#24](https://github.com/Cadenway/cadenway-realtime-gateway/issues/24)) ([283ac23](https://github.com/Cadenway/cadenway-realtime-gateway/commit/283ac238c22f7a419f3d9a8b57614808088e0ac5))
* **realtime:** relay Git task link invalidations ([#26](https://github.com/Cadenway/cadenway-realtime-gateway/issues/26)) ([468de1d](https://github.com/Cadenway/cadenway-realtime-gateway/commit/468de1dd734534897e22bfcc6c9eff1cd28b5aa9))
* **relays:** relay git.pr-reopened.v1 and git.link-updated.v1 as git.links-changed.v1 ([#34](https://github.com/Cadenway/cadenway-realtime-gateway/issues/34)) ([88a7dd0](https://github.com/Cadenway/cadenway-realtime-gateway/commit/88a7dd0d6395298c4a2110e3da25c48f2da19423))
* **relays:** relay list.tasks-changed.v1 for task membership changes ([#33](https://github.com/Cadenway/cadenway-realtime-gateway/issues/33)) ([54f698a](https://github.com/Cadenway/cadenway-realtime-gateway/commit/54f698aa2fd4aca9344822df4f910db9af8adfe8))


### Bug Fixes

* **realtime:** bound cross-replica recipient discovery ([#29](https://github.com/Cadenway/cadenway-realtime-gateway/issues/29)) ([f102710](https://github.com/Cadenway/cadenway-realtime-gateway/commit/f10271031a5af04ea7e0a69b3db0e33565f02529))
* **realtime:** revalidate membership and bound connection admission ([#27](https://github.com/Cadenway/cadenway-realtime-gateway/issues/27)) ([f243a7f](https://github.com/Cadenway/cadenway-realtime-gateway/commit/f243a7f52280511d1fc0c5f1ce8188908aa298c2))

## [0.3.0](https://github.com/Cadenway/cadenway-realtime-gateway/compare/v0.2.0...v0.3.0) (2026-11-16)


### Features

* wire the gateway onto nest-common 0.3.0 and nest-messaging 0.1.0 ([#18](https://github.com/Cadenway/cadenway-realtime-gateway/issues/18)) ([15a96d1](https://github.com/Cadenway/cadenway-realtime-gateway/commit/15a96d14aa6e6775a07af7fb05c11ffc46c777d5))

## [0.2.0](https://github.com/Cadenway/cadenway-realtime-gateway/compare/v0.1.0...v0.2.0) (2026-11-15)


### Features

* wire the gateway onto the service kit ([#16](https://github.com/Cadenway/cadenway-realtime-gateway/issues/16)) ([0627621](https://github.com/Cadenway/cadenway-realtime-gateway/commit/0627621a1db94e5189cb06ca558db53a522717db))

## 0.1.0 (2026-11-12)


### Bug Fixes

* **deploy:** sign the deploy commits with the bot's noreply address ([#3](https://github.com/Cadenway/cadenway-realtime-gateway/issues/3)) ([669a814](https://github.com/Cadenway/cadenway-realtime-gateway/commit/669a814eb28829e04bed9066e46fb26f8cab3795))
