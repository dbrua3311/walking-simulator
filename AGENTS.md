# Walking Simulator 작업 규칙

- README.md 및 docs/ARCHITECTURE.md, docs/STORAGE.md를 먼저 읽는다.
- 현재는 설계 단계다. 사용자가 코딩 시작을 지시하기 전 앱 생성·패키지 설치를 하지 않는다.
- 이름은 Walking Simulator, 폴더는 walking-simulator다.
- GitHub 원격은 `https://github.com/dbrua3311/walking-simulator.git`만 사용한다. 앞으로도 이 새 저장소에 업로드하며, push 전에 저장소 루트와 origin의 fetch/push 주소를 확인한다. 기존 aple·race-simulator 저장소에는 올리지 않는다.
- 기존 aple 계열 및 race-simulator 폴더에 쓰기, 이동, 삭제, Git 작업을 하지 않는다.
- 새 프로젝트의 소스와 Git은 /mnt/extra/walking-simulator 안에서 관리한다. 기존 저장소를 부모나 원격으로 사용하지 않는다.
- 대용량 캐시, 브라우저 바이너리, 실험, 내보내기, 테스트 산출물은 USB의 walking-simulator 전용 경로에 둔다. 기존 USB 자료는 건드리지 않는다.
- 마운트가 없으면 설치·쓰기 작업을 중단한다. 메인 파일시스템으로 자동 대체하지 않는다.
- 사용자 홈의 전역 npm·브라우저 캐시 설정을 변경하지 않는다. 프로젝트 실행 환경에서만 경로를 지정한다.
- 실제 고정 시간 간격 물리 계산과 실제 교차·돌연변이를 사용한다. 좋은 결과를 합성하지 않는다.
- UI와 물리 공간을 분리하고, 자동 정지는 Worker와 World를 파괴하지 않는다.
- Git 도입 이후 기능 브랜치에서 작업하고 커밋 파일 목록을 먼저 보여 주어 확인받는다. 파일을 지정해서 add한다. 강제 push와 기존 이력 수정은 하지 않는다.
- 커밋 전 변경에 맞는 Vitest·타입 검사·빌드, UI 변경 시 관련 Playwright 검증을 통과시킨다. Python 앱이 아니므로 aple의 pytest 규칙을 이 프로젝트에 복사하지 않는다.
