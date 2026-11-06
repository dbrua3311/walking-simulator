# Walking Simulator

실제 2D 강체 물리와 유전 알고리즘으로 사족보행 로봇의 보행 패턴을 탐색하는 독립 프로젝트.

2026-11-06 기준 **설계·개발 준비 단계**다. GitHub 비공개 저장소와 로컬 Git 연결을 준비했다. 실행 가능한 앱 생성과 의존성 설치는 아직 하지 않았다. 본격 코딩은 사용자의 시작 지시 이후 진행한다. 기존 Race Simulator를 개명하거나 전환하는 작업이 아니다.

- GitHub: [dbrua3311/walking-simulator](https://github.com/dbrua3311/walking-simulator)
- 프로젝트: `/mnt/extra/walking-simulator`
- 대용량 저장소: `/mnt/piper-usb/walking-simulator`
- 기존 `aple*`, `race-simulator` 프로젝트는 수정·이동·복사하지 않는다.
- 화면 및 안내는 한국어, 제품명은 Walking Simulator로 통일한다.
- 2D 측면 모델이며 실제 3D 사족보행의 좌우 균형을 재현하지 않는다.
- 학습 결과나 개선 수치를 만들어내지 않는다.

문서 읽기 순서:

1. [프로젝트 범위와 기능 분류](docs/PROJECT_OVERVIEW.md)
2. [제품 동작 명세](docs/PRODUCT_SPEC.md)
3. [물리·제어·진화 구조](docs/ARCHITECTURE.md)
4. [단계별 구현 계획](docs/IMPLEMENTATION_PLAN.md)
5. [검증 기준](docs/ACCEPTANCE_TESTS.md)
6. [저장 공간 운영](docs/STORAGE.md)
7. [기술 위험과 조사 근거](docs/RISKS_AND_REFERENCES.md)

문서의 물리 수치·성능 목표는 초기 설계안이며 실제 실험 결과가 아니다.
