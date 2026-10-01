// 종목 섹터 — 화면에 짧은 한국어 업종명으로 보여준다 (예: OKTA 보안, PLTR 소프트웨어, 삼성전자 메모리).
// 1순위: 아래 직접 정리한 표 (세부 업종까지).  2순위: 수집한 업종 정보 (미국 = 종목 페이지 업종, 국내 = KIS 업종명).
// 3순위(국내): 종목명 규칙 (○○금융지주 → 금융지주 등).  없으면 null.

const US = {
  // 반도체·하드웨어
  NVDA: 'AI 반도체', AMD: 'AI 반도체', AVGO: 'AI 반도체', MRVL: 'AI 반도체', ARM: '반도체 설계', QCOM: '모바일 반도체', INTC: '반도체',
  MU: '메모리', SNDK: '메모리', WDC: '저장장치', STX: '저장장치', TXN: '아날로그 반도체', ADI: '아날로그 반도체', MCHP: '아날로그 반도체',
  NXPI: '차량 반도체', ON: '전력 반도체', MPWR: '전력 반도체', SWKS: 'RF 반도체', QRVO: 'RF 반도체',
  AMAT: '반도체 장비', LRCX: '반도체 장비', KLAC: '반도체 장비', TER: '반도체 테스트', ASML: '반도체 장비', ENTG: '반도체 소재',
  CDNS: '반도체 설계SW', SNPS: '반도체 설계SW', GFS: '파운드리', TSM: '파운드리', MKSI: '반도체 장비', FSLR: '태양광',
  ANET: '네트워크 장비', CSCO: '네트워크 장비', JNPR: '네트워크 장비', CIEN: '광통신', COHR: '광통신', LITE: '광통신', GLW: '광섬유·유리',
  APH: '커넥터', TEL: '커넥터', DELL: '서버·PC', HPE: '서버', SMCI: 'AI 서버', HPQ: 'PC·프린터', AAPL: '스마트폰', NTAP: '스토리지',
  PSTG: '스토리지', JBL: '전자제조', FLEX: '전자제조', KEYS: '계측장비', TDY: '계측장비', ZBRA: '바코드·장비', TRMB: '측위장비',
  GRMN: 'GPS 기기', CDW: 'IT 유통', IT: 'IT 리서치', LOGI: 'PC 주변기기',
  // 소프트웨어·인터넷
  MSFT: '소프트웨어·클라우드', ORCL: '클라우드 DB', CRM: 'CRM 소프트웨어', NOW: '업무 자동화 SW', ADBE: '디자인 소프트웨어', INTU: '재무 소프트웨어',
  PLTR: '소프트웨어', SNOW: '데이터 클라우드', DDOG: '모니터링 SW', MDB: '데이터베이스', TEAM: '협업 소프트웨어', WDAY: 'HR 소프트웨어',
  ADSK: '설계 소프트웨어', PTC: '설계 소프트웨어', ANSS: '시뮬레이션 SW', TYL: '공공 소프트웨어', ROP: '산업 소프트웨어', FICO: '신용평가 SW',
  PANW: '보안', CRWD: '보안', FTNT: '보안', ZS: '보안', OKTA: '보안', NET: '보안·CDN', CHKP: '보안', S: '보안', CYBR: '보안', GEN: '보안',
  APP: '광고 소프트웨어', TTD: '광고 소프트웨어', SHOP: '이커머스 SW', HUBS: '마케팅 SW', ZM: '화상회의', DOCU: '전자서명', AKAM: 'CDN·보안',
  ADP: '급여 대행', PAYX: '급여 대행', PAYC: '급여 SW', CTSH: 'IT 서비스', ACN: 'IT 컨설팅', IBM: 'IT 서비스', EPAM: 'IT 서비스', GDDY: '웹호스팅',
  VRSN: '도메인', FDS: '금융 데이터', MSCI: '금융 데이터', SPGI: '신용평가', MCO: '신용평가', VRSK: '보험 데이터', CPRT: '중고차 경매',
  GOOGL: '인터넷 플랫폼', GOOG: '인터넷 플랫폼', META: '소셜미디어', AMZN: '이커머스·클라우드', NFLX: '스트리밍', DASH: '배달 플랫폼',
  UBER: '모빌리티 플랫폼', ABNB: '숙박 플랫폼', BKNG: '여행 플랫폼', EXPE: '여행 플랫폼', EBAY: '이커머스', MELI: '이커머스(중남미)',
  PDD: '이커머스(중국)', BIDU: '인터넷(중국)', JD: '이커머스(중국)', PYPL: '결제', XYZ: '결제', SQ: '결제', COIN: '가상자산 거래소', HOOD: '온라인 증권',
  MSTR: '비트코인 보유', TTWO: '게임', EA: '게임', RBLX: '게임', SPOT: '음원 스트리밍', WBD: '미디어', PARA: '미디어', FOX: '방송', FOXA: '방송',
  DIS: '미디어·테마파크', CMCSA: '케이블·미디어', CHTR: '케이블', LYV: '공연', NWSA: '언론', NWS: '언론', OMC: '광고대행', IPG: '광고대행',
  MTCH: '데이팅 앱', PINS: '소셜미디어', SNAP: '소셜미디어', CRWV: 'AI 클라우드', NBIS: 'AI 클라우드', CSGP: '부동산 데이터',
  // 통신
  T: '통신', VZ: '통신', TMUS: '통신',
  // 금융
  JPM: '은행', BAC: '은행', WFC: '은행', C: '은행', USB: '은행', PNC: '은행', TFC: '은행', FITB: '지방은행', HBAN: '지방은행', RF: '지방은행',
  KEY: '지방은행', CFG: '지방은행', MTB: '지방은행', ZION: '지방은행', COF: '카드·은행', AXP: '카드', SYF: '카드', DFS: '카드',
  V: '결제 네트워크', MA: '결제 네트워크', FIS: '금융 IT', FI: '금융 IT', FISV: '금융 IT', GPN: '결제 대행', JKHY: '금융 IT',
  GS: '투자은행', MS: '투자은행', SCHW: '증권', RJF: '증권', IBKR: '온라인 증권', BLK: '자산운용', BX: '사모펀드', KKR: '사모펀드', APO: '사모펀드',
  ARES: '사모펀드', TROW: '자산운용', BEN: '자산운용', IVZ: '자산운용', STT: '수탁은행', BK: '수탁은행', NTRS: '수탁은행', AMP: '자산관리',
  CME: '거래소', ICE: '거래소', NDAQ: '거래소', CBOE: '거래소', 'BRK.B': '복합기업(보험)', BRK: '복합기업(보험)',
  PGR: '자동차보험', ALL: '손해보험', TRV: '손해보험', CB: '손해보험', AIG: '보험', HIG: '보험', CINF: '손해보험', WRB: '손해보험', ACGL: '재보험',
  EG: '재보험', MET: '생명보험', PRU: '생명보험', AFL: '생명보험', PFG: '생명보험', GL: '생명보험', MMC: '보험중개', AON: '보험중개', AJG: '보험중개',
  BRO: '보험중개', WTW: '보험중개', ERIE: '보험', L: '보험 지주',
  // 헬스케어
  LLY: '비만·당뇨 신약', NVO: '비만·당뇨 신약', JNJ: '제약·의료기기', MRK: '제약', PFE: '제약', ABBV: '제약', BMY: '제약', AMGN: '바이오',
  GILD: '바이오', REGN: '바이오', VRTX: '바이오', BIIB: '바이오', MRNA: 'mRNA 바이오', ALNY: 'RNA 치료제', INCY: '바이오', AZN: '제약',
  ABT: '의료기기', MDT: '의료기기', BSX: '의료기기', SYK: '의료기기', ISRG: '수술 로봇', EW: '심장 의료기기', DXCM: '혈당측정기', PODD: '인슐린 펌프',
  ZBH: '정형외과 기기', BDX: '의료소모품', BAX: '의료소모품', GEHC: '의료영상', IDXX: '동물 진단', RMD: '수면 의료기기', STE: '멸균 장비',
  HOLX: '여성 진단', ALGN: '투명 교정', COO: '콘택트렌즈', TMO: '바이오 장비', DHR: '바이오 장비', A: '분석 장비', WAT: '분석 장비',
  MTD: '정밀 계측', IQV: '임상 대행', ILMN: '유전체 분석', CRL: '임상 대행', RVTY: '진단', WST: '주사 용기', TECH: '바이오 시약',
  UNH: '건강보험', ELV: '건강보험', CI: '건강보험', CVS: '약국·건강보험', HUM: '건강보험', CNC: '건강보험', MOH: '건강보험',
  HCA: '병원', UHS: '병원', DVA: '투석', MCK: '의약품 유통', COR: '의약품 유통', CAH: '의약품 유통', ZTS: '동물 의약품', VTRS: '제네릭',
  // 소비재
  WMT: '대형마트', COST: '창고형 할인점', TGT: '대형마트', KR: '식료품점', DG: '할인점', DLTR: '할인점', BJ: '창고형 할인점',
  HD: '주택용품', LOW: '주택용품', TJX: '할인 의류', ROST: '할인 의류', BBY: '전자제품 유통', ORLY: '자동차 부품', AZO: '자동차 부품',
  TSCO: '농촌 용품', ULTA: '화장품 유통', LULU: '애슬레저', NKE: '스포츠 의류', DECK: '신발', TPR: '패션', RL: '패션', CPRI: '패션',
  MCD: '외식', SBUX: '커피', CMG: '외식', YUM: '외식', DRI: '외식', DPZ: '피자', WING: '외식', CAVA: '외식',
  KO: '음료', PEP: '음료·스낵', MNST: '에너지 음료', KDP: '음료', STZ: '주류', TAP: '맥주', BF: '위스키',
  PG: '생활용품', CL: '생활용품', KMB: '생활용품', CHD: '생활용품', CLX: '생활용품', EL: '화장품', KVUE: '소비자 헬스',
  MDLZ: '제과', HSY: '제과', GIS: '식품', K: '식품', KHC: '식품', CPB: '식품', CAG: '식품', SJM: '식품', HRL: '식품', TSN: '육가공',
  MKC: '향신료', KMI: '가스 파이프라인', PM: '담배', MO: '담배', ADM: '곡물', BG: '곡물',
  TSLA: '전기차', GM: '자동차', F: '자동차', RIVN: '전기차', LCID: '전기차', APTV: '자동차 부품', BWA: '자동차 부품',
  MAR: '호텔', HLT: '호텔', H: '호텔', RCL: '크루즈', CCL: '크루즈', NCLH: '크루즈', LVS: '카지노', WYNN: '카지노', MGM: '카지노', CZR: '카지노',
  DAL: '항공', UAL: '항공', LUV: '항공', AAL: '항공', LEN: '주택건설', DHI: '주택건설', PHM: '주택건설', NVR: '주택건설', TOL: '주택건설',
  POOL: '수영장 용품', GPC: '자동차 부품', LKQ: '자동차 부품', KMX: '중고차', CVNA: '중고차 플랫폼', HAS: '완구', MAT: '완구',
  // 산업재·방산
  GE: '항공엔진', GEV: '전력 설비', ETN: '전력 설비', VRT: '데이터센터 전력', PWR: '전력 공사', EMR: '산업 자동화', ROK: '산업 자동화',
  HON: '복합 산업재', MMM: '복합 산업재', CAT: '건설기계', DE: '농기계', CMI: '엔진', PCAR: '트럭', ITW: '산업재', PH: '유압 장비',
  DOV: '산업재', IR: '압축기', XYL: '수처리', AME: '전자기기', FTV: '계측', OTIS: '엘리베이터', CARR: '공조', TT: '공조', JCI: '빌딩 설비',
  LII: '공조', HUBB: '전기 부품', AOS: '온수기', SNA: '공구', SWK: '공구', GWW: '산업재 유통', FAST: '산업재 유통', URI: '장비 렌탈',
  LMT: '방산', NOC: '방산', GD: '방산·조선', RTX: '방산·항공', LHX: '방산 전자', HII: '군함', BA: '항공기', TDG: '항공 부품', HWM: '항공 부품',
  TXT: '항공기', AXON: '치안 장비', LDOS: '방산 IT', BAH: '방산 IT', HEI: '항공 부품',
  UNP: '철도', CSX: '철도', NSC: '철도', UPS: '택배', FDX: '택배', ODFL: '트럭 운송', JBHT: '물류', CHRW: '물류', EXPD: '물류',
  WM: '폐기물', RSG: '폐기물', WCN: '폐기물', CTAS: '유니폼 렌탈', RHI: '인력 파견', J: '엔지니어링', ACM: '엔지니어링', EME: '전기 공사',
  FIX: '설비 공사', MLM: '골재', VMC: '골재', BLDR: '건자재', MAS: '건자재', NUE: '철강', STLD: '철강', FCX: '구리', NEM: '금광',
  // 에너지·유틸리티·소재
  XOM: '석유', CVX: '석유', COP: '석유 개발', EOG: '석유 개발', OXY: '석유 개발', DVN: '석유 개발', FANG: '석유 개발', APA: '석유 개발',
  HES: '석유 개발', CTRA: '천연가스', EQT: '천연가스', EXE: '천연가스', SLB: '유전 서비스', HAL: '유전 서비스', BKR: '유전 장비',
  VLO: '정유', MPC: '정유', PSX: '정유', OKE: '가스 파이프라인', WMB: '가스 파이프라인', TRGP: '가스 처리', LNG: 'LNG 수출',
  NEE: '전력·재생에너지', DUK: '전력', SO: '전력', D: '전력', AEP: '전력', EXC: '전력', XEL: '전력', SRE: '전력·가스', PCG: '전력',
  ED: '전력', PEG: '전력', EIX: '전력', ETR: '전력', WEC: '전력', ES: '전력', DTE: '전력', AEE: '전력', PPL: '전력', CNP: '전력', FE: '전력',
  CEG: '원전 발전', VST: '발전', NRG: '발전', TLN: '발전', AES: '발전', AWK: '수도',
  LIN: '산업가스', APD: '산업가스', SHW: '페인트', PPG: '페인트', ECL: '위생 화학', DD: '특수화학', DOW: '화학', LYB: '화학', CE: '화학',
  ALB: '리튬', MOS: '비료', CF: '비료', CTVA: '종자·농약', IFF: '향료', IP: '제지', PKG: '포장재', AMCR: '포장재', BALL: '캔 포장',
  // 부동산
  PLD: '물류 리츠', AMT: '통신탑 리츠', CCI: '통신탑 리츠', SBAC: '통신탑 리츠', EQIX: '데이터센터 리츠', DLR: '데이터센터 리츠',
  PSA: '창고 리츠', O: '상업 리츠', SPG: '쇼핑몰 리츠', WELL: '헬스케어 리츠', VTR: '헬스케어 리츠', AVB: '주거 리츠', EQR: '주거 리츠',
  CBRE: '부동산 서비스', IRM: '문서보관·데이터센터',
};

const KR = {
  '005930': '메모리', '000660': '메모리', '009150': '반도체기판·MLCC', '011070': '카메라모듈', '066570': '가전', '034220': '디스플레이',
  '042700': '반도체 장비', '000990': '파운드리', '058470': '반도체 소켓', '357780': '반도체 소재', '240810': '반도체 장비', '039030': '반도체 장비',
  '403870': '반도체 장비', '095340': '반도체 소켓', '036930': '반도체 장비', '166090': '반도체 소재', '005290': '반도체 소재', '319660': '반도체 장비',
  '095610': '반도체 장비', '140860': '반도체 장비', '064760': '반도체 소재', '222800': '반도체 기판',
  '108320': '반도체 설계', '007660': '반도체 기판', '272290': '반도체 소재', '089030': '반도체 장비', '131970': '반도체 테스트',
  '373220': '2차전지', '006400': '2차전지', '051910': '화학·2차전지', '003670': '2차전지 소재', '247540': '2차전지 소재', '086520': '2차전지 소재',
  '066970': '2차전지 소재', '450080': '2차전지 소재', '005070': '2차전지 소재', '361610': '2차전지 소재', '020150': '2차전지 소재', '278280': '2차전지 소재',
  '121600': '2차전지 소재', '348370': '2차전지 소재', '336370': '2차전지 소재', '096770': '정유·2차전지', '011790': '2차전지 소재',
  '005380': '자동차', '000270': '자동차', '012330': '자동차 부품', '204320': '자동차 부품', '011210': '자동차 부품', '161390': '타이어', '073240': '타이어',
  '018880': '자동차 부품', '086280': '물류', '011200': '해운', '028670': '해운', '003490': '항공', '020560': '항공', '180640': '항공 지주',
  '012450': '방산', '047810': '방산·항공', '079550': '방산', '064350': '방산·철도', '272210': '방산', '103140': '방산', '000880': '방산·지주',
  '329180': '조선', '009540': '조선', '010140': '조선', '042660': '조선', '010620': '조선', '267250': '조선 지주', '082740': '선박 엔진', '077970': '선박 엔진',
  '034020': '원전·발전설비', '267260': '전력기기', '298040': '전력기기', '010120': '전력기기', '006260': '전선·전력', '001440': '전선', '103590': '전력기기',
  '062040': '전력기기', '015760': '전력', '036460': '가스', '052690': '원전 설계', '051600': '원전 정비', '000720': '건설', '028050': '플랜트',
  '006360': '건설', '047040': '건설', '375500': '건설', '294870': '건설', '000150': '복합 지주', '241560': '건설기계', '042670': '건설기계', '267270': '건설기계',
  '005490': '철강', '004020': '철강', '010130': '비철금속', '001230': '철강',
  '011170': '석유화학', '009830': '태양광·화학', '010950': '정유', '078930': '정유 지주', '285130': '화학', '298020': '화학섬유', '298050': '탄소섬유', '120110': '화학섬유',
  '011780': '합성고무', '004000': '화학', '006650': '화학', '298000': '화학',
  '105560': '금융지주', '055550': '금융지주', '086790': '금융지주', '316140': '금융지주', '138040': '금융지주', '024110': '은행', '175330': '금융지주',
  '139130': '금융지주', '323410': '인터넷은행', '377300': '간편결제', '032830': '생명보험', '000810': '손해보험', '005830': '손해보험', '001450': '손해보험',
  '088350': '생명보험', '082640': '생명보험', '071050': '증권', '016360': '증권', '006800': '증권', '039490': '증권', '005940': '증권', '003540': '증권',
  '029780': '카드',
  '035420': '인터넷 플랫폼', '035720': '인터넷 플랫폼', '018260': 'IT 서비스', '307950': 'IT 서비스', '022100': 'IT 서비스', '012510': '소프트웨어',
  '017670': '통신', '030200': '통신', '032640': '통신', '259960': '게임', '036570': '게임', '251270': '게임', '263750': '게임', '293490': '게임',
  '112040': '게임', '078340': '게임', '225570': '게임', '352820': '엔터', '041510': '엔터', '035900': '엔터', '122870': '엔터', '253450': '드라마 제작',
  '035760': '미디어', '079160': '영화관',
  '207940': '바이오 위탁생산', '068270': '바이오시밀러', '196170': '바이오 플랫폼', '028300': '항암 신약', '000100': '제약', '128940': '제약',
  '326030': '신약', '302440': '백신', '185750': '제약', '006280': '백신·혈액제제', '145020': '보톡스', '214150': '미용 의료기기', '141080': 'ADC 신약',
  '087010': '약물 전달', '298380': '이중항체 신약', '237690': '올리고 원료', '000250': '신약', '950160': '신약', '096530': '진단', '214450': '미용 의료',
  '085660': '바이오', '048410': '바이오', '310210': '바이오', '039200': '바이오', '195940': '신약', '009420': '제약', '003850': '제약', '069620': '제약',
  '001060': '제약', '000120': '택배', '097950': '식품', '271560': '제과', '004370': '라면', '003230': '라면', '007310': '식품', '280360': '제과',
  '033780': '담배', '090430': '화장품', '051900': '화장품·생활용품', '161890': '화장품 ODM', '192820': '화장품 ODM', '278470': '뷰티 디바이스',
  '257720': '화장품', '018250': '화장품', '023530': '유통', '004170': '백화점', '139480': '대형마트', '069960': '백화점', '282330': '편의점',
  '007070': '편의점', '008770': '면세점', '111770': '의류 OEM', '081660': '의류', '383220': '의류', '020000': '의류',
  '003550': '전자 지주', '034730': '복합 지주', '028260': '복합 지주', '001040': '식품 지주', '004990': '유통 지주', '002380': '건자재',
  '009240': '가구', '021240': '렌탈', '010060': '태양광·화학', '112610': '풍력',
  '003000': '제약', '402340': '복합 지주',
};

const IND_KO = {
  'Semiconductors': '반도체', 'Semiconductor Equipment & Materials': '반도체 장비', 'Software - Infrastructure': '소프트웨어', 'Software - Application': '소프트웨어',
  'Information Technology Services': 'IT 서비스', 'Communication Equipment': '통신장비', 'Computer Hardware': '컴퓨터 하드웨어', 'Electronic Components': '전자부품',
  'Scientific & Technical Instruments': '계측장비', 'Consumer Electronics': '가전', 'Internet Content & Information': '인터넷', 'Internet Retail': '이커머스',
  'Entertainment': '미디어', 'Electronic Gaming & Multimedia': '게임', 'Telecom Services': '통신', 'Advertising Agencies': '광고',
  'Banks - Diversified': '은행', 'Banks - Regional': '지방은행', 'Credit Services': '카드·신용', 'Capital Markets': '증권·IB', 'Asset Management': '자산운용',
  'Insurance - Diversified': '보험', 'Insurance - Property & Casualty': '손해보험', 'Insurance - Life': '생명보험', 'Insurance Brokers': '보험중개',
  'Insurance - Reinsurance': '재보험', 'Financial Data & Stock Exchanges': '금융 데이터·거래소',
  'Drug Manufacturers - General': '제약', 'Drug Manufacturers - Specialty & Generic': '제약', 'Biotechnology': '바이오', 'Medical Devices': '의료기기',
  'Medical Instruments & Supplies': '의료소모품', 'Diagnostics & Research': '진단·연구장비', 'Healthcare Plans': '건강보험', 'Medical Care Facilities': '병원',
  'Medical Distribution': '의약품 유통', 'Health Information Services': '헬스케어 IT',
  'Discount Stores': '할인점', 'Specialty Retail': '전문 소매', 'Home Improvement Retail': '주택용품', 'Apparel Retail': '의류 소매', 'Restaurants': '외식',
  'Beverages - Non-Alcoholic': '음료', 'Beverages - Brewers': '맥주', 'Beverages - Wineries & Distilleries': '주류', 'Household & Personal Products': '생활용품',
  'Packaged Foods': '식품', 'Confectioners': '제과', 'Tobacco': '담배', 'Farm Products': '농산물', 'Grocery Stores': '식료품점',
  'Auto Manufacturers': '자동차', 'Auto Parts': '자동차 부품', 'Auto & Truck Dealerships': '자동차 딜러', 'Lodging': '호텔', 'Resorts & Casinos': '카지노',
  'Travel Services': '여행', 'Airlines': '항공', 'Residential Construction': '주택건설', 'Apparel Manufacturing': '의류', 'Footwear & Accessories': '신발',
  'Leisure': '레저', 'Luxury Goods': '명품', 'Gambling': '게임·베팅',
  'Aerospace & Defense': '방산·항공', 'Specialty Industrial Machinery': '산업기계', 'Farm & Heavy Construction Machinery': '건설기계',
  'Electrical Equipment & Parts': '전력 설비', 'Engineering & Construction': '건설·엔지니어링', 'Building Products & Equipment': '건자재',
  'Industrial Distribution': '산업재 유통', 'Railroads': '철도', 'Integrated Freight & Logistics': '물류', 'Trucking': '트럭 운송',
  'Waste Management': '폐기물', 'Conglomerates': '복합기업', 'Specialty Business Services': '사업 서비스', 'Rental & Leasing Services': '렌탈',
  'Staffing & Employment Services': '인력', 'Consulting Services': '컨설팅', 'Security & Protection Services': '보안 서비스', 'Tools & Accessories': '공구',
  'Oil & Gas Integrated': '석유', 'Oil & Gas E&P': '석유 개발', 'Oil & Gas Refining & Marketing': '정유', 'Oil & Gas Midstream': '파이프라인',
  'Oil & Gas Equipment & Services': '유전 서비스', 'Utilities - Regulated Electric': '전력', 'Utilities - Diversified': '유틸리티',
  'Utilities - Independent Power Producers': '발전', 'Utilities - Renewable': '재생에너지', 'Utilities - Regulated Gas': '가스', 'Utilities - Regulated Water': '수도',
  'Specialty Chemicals': '특수화학', 'Chemicals': '화학', 'Agricultural Inputs': '비료·농약', 'Steel': '철강', 'Copper': '구리', 'Gold': '금광',
  'Building Materials': '건자재', 'Packaging & Containers': '포장재', 'Paper & Paper Products': '제지', 'Solar': '태양광',
  'REIT - Industrial': '물류 리츠', 'REIT - Specialty': '특수 리츠', 'REIT - Retail': '상업 리츠', 'REIT - Residential': '주거 리츠',
  'REIT - Healthcare Facilities': '헬스케어 리츠', 'REIT - Office': '오피스 리츠', 'REIT - Diversified': '리츠', 'Real Estate Services': '부동산 서비스',
};

/** 국내 종목명 규칙 */
const KR_NAME = [
  [/금융지주$/, '금융지주'], [/(은행)$/, '은행'], [/증권$/, '증권'], [/(화재|손해보험)$/, '손해보험'], [/생명$/, '생명보험'], [/카드$/, '카드'],
  [/(바이오|제약|약품|파마|셀|젠)$/, '제약·바이오'], [/(건설|E&C|이앤씨)$/, '건설'], [/(중공업|조선|해양)$/, '조선·중공업'], [/(에너지|전력|파워)/, '에너지'],
  [/(화학|케미칼|케미칼즈)/, '화학'], [/(철강|스틸|제철)/, '철강'], [/(엔터|엔터테인먼트|스튜디오)/, '엔터'], [/(게임즈|게임)/, '게임'],
  [/(반도체|세미콘|테크|머티리얼)/, '반도체·부품'], [/(전자|일렉)/, '전자'], [/(식품|푸드|제과)/, '식품'], [/(홀딩스|지주)$/, '지주'], [/(통신|텔레콤)/, '통신'],
  [/(화장품|코스메틱|뷰티)/, '화장품'], [/(물산|상사|인터내셔널)$/, '상사'], [/(자동차|모비스|오토)/, '자동차'], [/(항공|에어)/, '항공'],
];

/** 국내 KIS 업종명(표준산업분류 등) → 짧게 */
export function shortKrIndustry(s) {
  if (!s) return null;
  let t = String(s).replace(/\s+/g, ' ').trim();
  t = t.replace(/(제조업|업)$/, '').replace(/ 및 /g, '·').replace(/기타 /, '').trim();
  return t.length > 12 ? t.slice(0, 12) : t || null;
}

/** 미국 업종(영문) → 한국어 */
export const usIndustryKo = s => (s ? IND_KO[s] || s : null);

/**
 * 섹터 하나. collected = 수집한 업종 정보 (미국: 영문 업종, 국내: KIS 업종명)
 */
export function sectorOf(m, code, { name = null, collected = null } = {}) {
  if (m === 'US') {
    const c = String(code || '').toUpperCase();
    if (US[c]) return US[c];
    return collected ? usIndustryKo(collected) : null;
  }
  if (KR[code]) return KR[code];
  if (collected) return shortKrIndustry(collected);
  if (name) for (const [re, v] of KR_NAME) if (re.test(name)) return v;
  return null;
}
