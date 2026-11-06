# 기술 위험과 대응

| 예상 문제 | 대응·검증 |
| --- | --- |
| 측면에 4다리가 겹침 | 독립 관절·자가 충돌 제외·먼 다리 명도 구분, 3D 한계 명시 |
| 과도한 토크·관절 튐 | 유한 토크·속도·각도 제한, 작은 dt, 초기 접촉·질량비 검증 |
| 초기 낙하가 전부 실패 | 발 높이·관절 referenceAngle과 시작 자세부터 확인; 결과를 좋은 보행으로 치환하지 않음 |
| 최고 거리만 이용한 굴림·점프 | 유효 자세·접촉·높이 조건, 종료 전 부당 이동 제외, 편법 사례 회귀 테스트 |
| 진화 정체 | 다수 시드 기준선, 유전자 포화·부모 다양성·물리 제약을 분리 분석 |
| Worker가 멈추지 않음 | 짧은 계산 묶음·정지 ack·진화 전 명령 확인, UI 지연 측정 |
| 표시 배속과 실제 속도 차이 | 실제 처리 tick/벽시계 비율 표시, dt·물리 프레임 생략 금지 |
| 렌더 메시지·궤적 메모리 누적 | 최신 스냅샷만 전달, 최고 궤적만 장기 보관, 오래된 World 해제 |
| 중간 JSON 복원 시 solver 상태 차이 | 초기에는 세대 경계 저장만 보장, 메모리 일시정지와 분리 |
| 저장 중 USB 분리·용량 부족 | 마운트·용량 검사와 저장 실패 안내, 기존 실험 유지, 메인 fallback 금지 |
| 브라우저가 메인에 기록 저장 | 파일 선택기·전용 프로필 검토, 기존 프로필 변경 없이 경로 확인 |
| 장기 학습 개선의 과장 | 시드별 실패 포함 원본 통계 보존, 개선 없으면 그대로 보고 |

## 공식 문서 확인

아래 문서는 2026-11-06 설계 준비 과정에서 확인했다. 엔진의 관절/World 기능과 개발 도구의 Worker·캐시 설정을 뒷받침한다. 위의 체형·27개 유전자·평가 공식·시간 수치·운영 정책은 프로젝트 설계 제안이며 공식 문서에서 보장하는 학습 성능이 아니다.

- [Planck RevoluteJointDef](https://piqnt.com/planck.js/docs/api/interfaces/RevoluteJointDef.html): 회전 관절, 상대 각도·모터·토크 제한 관련 API.
- [Planck World](https://piqnt.com/planck.js/docs/api/classes/World.html): 독립 물리 공간과 step API.
- [Vite Features](https://vite.dev/guide/features): Web Worker 통합 방식.
- [Vite Shared Options](https://vite.dev/config/shared-options): 프로젝트별 cacheDir 지정.
- [Playwright Browsers](https://playwright.dev/docs/browsers): 브라우저 설치와 PLAYWRIGHT_BROWSERS_PATH 관리.

기존 Race Simulator의 소스 구조는 이번에 조사하지 않았다. 코드 복사 없이 원문 요구사항 수준으로 유지 기능과 교체 기능을 분류했으므로 재사용률이나 기존 구현 상태를 주장하지 않는다.
