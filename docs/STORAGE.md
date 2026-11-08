# 저장 공간 운영

2026-11-06 확인값: 메인 Ubuntu `/` 약 297MB, 별도 `/mnt/extra` 약 8.4GB, USB `/mnt/piper-usb` 약 77GB 여유. 시점에 따라 달라지므로 설치 전 다시 확인한다. `/tmp`도 현재 메인 파일시스템이므로 대용량 임시 저장소로 사용하지 않는다.

| 내용                             | 저장 위치                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------- |
| 설계 문서·향후 소스·Git·lockfile | /mnt/extra/walking-simulator                                                 |
| 프로젝트별 node_modules          | /mnt/extra/walking-simulator/node_modules                                    |
| npm 다운로드 캐시                | /mnt/piper-usb/walking-simulator/cache/npm                                   |
| Vite·Vitest 캐시                 | /mnt/piper-usb/walking-simulator/cache/vite 및 cache/vitest                  |
| Playwright 브라우저              | /mnt/piper-usb/walking-simulator/cache/ms-playwright                         |
| 기타 프로젝트 캐시               | /mnt/piper-usb/walking-simulator/cache/xdg                                   |
| 도구용 임시 파일                 | /mnt/piper-usb/walking-simulator/tmp                                         |
| 향후 Node 도구가 필요한 경우     | /mnt/extra/walking-simulator/.tools                                          |
| 빌드 산출물                      | /mnt/piper-usb/walking-simulator/artifacts/dist                              |
| E2E 결과·보고서·실패 캡처        | /mnt/piper-usb/walking-simulator/artifacts/test-results 및 playwright-report |
| 실험 JSON·CSV·궤적               | /mnt/piper-usb/walking-simulator/experiments                                 |
| 명시적 실험 내보내기             | /mnt/piper-usb/walking-simulator/exports                                     |
| 사용자 요청 시 소스 백업         | /mnt/piper-usb/walking-simulator/backups                                     |

2026-11-07 scripts/run.sh로 프로젝트 환경을 분리했다. Node는 기존 외부 파티션 설치를 읽어서 사용하고 의존성은 node_modules, 캐시·Chromium·산출물은 위 USB 전용 경로에 설치했다. 전역 설정은 변경하지 않았다.

소스와 node_modules를 같은 ext4 파티션에 두면 파일 감시·패키지 탐색이 USB 연결 상태에 덜 의존한다. 캐시·빌드·실험처럼 재생성 가능하거나 용량이 커지는 항목은 USB에 둔다. 소스와 개발 의존성도 메인 Ubuntu 파티션에 두지 않는다.

코딩 단계에서 프로젝트 전용 실행 환경에 npm_config_cache, PLAYWRIGHT_BROWSERS_PATH, XDG_CACHE_HOME, TMPDIR을 위 경로로 지정하고 Vite cacheDir·build.outDir 및 테스트 출력 경로도 명시한다. 전역 ~/.npmrc, 쉘 초기화 파일과 다른 프로젝트 설정을 수정하지 않는다. Vite 외부 outDir 정리 시 새 프로젝트 전용 폴더인지 확인하고 USB의 상위 디렉터리를 정리 대상으로 지정하지 않는다.

설치·실험 전 mountpoint와 findmnt로 `/mnt/extra`, `/mnt/piper-usb`가 실제 별도 장치로 마운트됐는지 검사한다. 폴더가 존재하는지만으로 판단하지 않는다. 마운트가 없으면 쓰기를 중단한다. 재연결 후 대상 파일시스템도 확인한다. USB가 없을 때 저장 경로를 홈·Downloads·/tmp로 바꾸지 않는다.

브라우저 프로필·HTTP 캐시는 별도 문제다. 개발용 브라우저 실행 시 USB 전용 프로필을 검토하며 기존 Firefox 프로필을 이동하거나 전역 설정을 바꾸지 않는다. 사용자가 기존 브라우저로 접속하면 브라우저가 메인에 소량 캐시를 남길 가능성을 설명한다. JSON/CSV 저장 위치는 파일 선택기로 USB를 지정한다. IndexedDB/localStorage에 대량 실험을 자동 보관하지 않는다.

초기 공간 목표: 소스·Git·node_modules 합계 2GB 이하, 외부 파티션 여유 2GB 이상 유지. 이는 할당량을 강제한 상태가 아니라 운영 기준이다. 메인 여유가 현재처럼 작은 경우 신규 설치를 시작하지 않고 외부 경로를 먼저 검증한다. 실험 기록 상한과 실패 스크린샷만 보관하는 정책을 설정한다. 자동 삭제를 도입한다면 오직 이 프로젝트 전용 재생성 캐시에만 적용하고 사용자 실험·다른 프로젝트는 삭제하지 않는다.

2026-11-07 0.4.0 검증 시 여유: 메인 약 773MB, 별도 파티션 약 8.1GB, USB 약 76GB. 이번 수정에서 새 의존성은 설치하지 않았으며 100세대 다중 시드 JSON·CSV·궤적과 브라우저 결과는 전용 USB 경로에 저장했다.

2026-11-07 0.5.0: 단계별 실험 원본·매 10세대 체크포인트·소스 목록 해시·브라우저 결과도 위 전용 USB 경로에 저장했다. 새 의존성을 설치하지 않았다. 확인 시 여유는 메인 약 736MB, 별도 파티션 약 8.1GB, USB 약 76GB였다.

2026-11-07 0.6.0: 시간 입력·확대 탐색의 검사/브라우저/실험 원본도 USB 전용 경로에 둔다. 신규 의존성 설치 없음. 확인 시 메인 약 732MB, 별도 파티션 약 8.1GB, USB 약 76GB 여유다.
