# 교사 계정 허용 목록 설정

교사 대시보드 권한은 Google 로그인 여부만으로 주지 않는다. 학생도 Google 계정을
가질 수 있으므로, Firestore의 `teachers/{uid}` 문서가 있는 계정만 학급을
만들고 수정·삭제할 수 있다.

## 규칙을 배포하기 전에 할 일

1. Firebase Console → Authentication → Users에서 사용할 교사 계정의 **User UID**를 복사한다.
2. Firestore Database에서 `teachers` 컬렉션을 만든다.
3. 문서 ID를 복사한 UID와 **완전히 똑같이** 입력한다.
4. 문서에는 관리용으로 `name`, `email` 같은 필드를 적어도 되지만, 권한 판정은 문서 존재 여부만 본다.
5. 교사 계정이 여러 개면 UID마다 문서를 하나씩 만든다.
6. 그 뒤에 `firebase deploy --only firestore:rules`로 규칙을 배포한다.

`teachers` 컬렉션은 브라우저에서 만들거나 고칠 수 없다. Firebase Console 또는
Admin SDK에서만 관리한다. 허용되지 않은 계정으로 교사 화면에 로그인하면 화면에
자기 UID가 표시되므로, 관리자는 그 값을 확인해 등록할 수 있다.

## 배포 전 회귀 확인

- 등록된 교사 UID: 자기 학급 목록 조회와 새 학급 생성이 성공해야 한다.
- 등록되지 않은 Google 계정: 교사 화면에서 허용 목록 안내가 나오고 학급 생성이 거부되어야 한다.
- 익명 학생 계정: 기존처럼 학급 생성이 거부되어야 한다.
- 학생 입장: `joinCodes/{코드}`와 `classes/{id}` 읽기는 계속 성공해야 한다.
