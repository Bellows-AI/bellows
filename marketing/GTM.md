# Bellows — Go-to-Market 3.2 (MEDDPICC + Delivery Metrics + Objections)

**Стратегічний документ • Жовтень 2026 • Робоча версія для ухвалення рішень**  
**Тема:** Product задає зміни, Engineering — правила, Bellows — виконання. **MCP у коробці open source, Cloud = zero-infrastructure-ops / ready-to-run, Economic Buyer = CTO.** GTM-кваліфікація через MEDDPICC.

> **Product teams drive change. Engineers define the guardrails. Bellows does the work.**  
> Your AI chat. Your real codebase. From product idea to reviewed PR — without leaving the conversation.

**Теза.** Bellows не просто дає PM право запускати coding agents. Ми змінюємо розподіл роботи: **Product визначає, що потрібно змінити; Engineering визначає, як система має залишатися правильною; Bellows виконує повторювану реалізацію та перевірки у реальному репозиторії.** **Продуктове рішення: MCP входить у Bellows Community з коробки, без окремої ліцензії чи Cloud-paywall.** Дата/стан фактичного релізу перевіряються за GitHub tag, документацією та тестом встановлення, а не припускаються в sales-доказах. Cloud не продає доступ до MCP: Cloud продає інфраструктуру, надійну експлуатацію, оновлення та підтримку. Хто хоче самостійно хостити й підтримувати Bellows — може робити це без підписки.

**Головний бренд-слоган:** *Product teams drive change. Engineers define the guardrails. Bellows does the work.*  
**Use-case повідомлення для Product:** *Your AI chat. Your real codebase.*  
**Engineering повідомлення:** *Own the architecture. Not every implementation detail.*  
**CTO повідомлення:** *Product autonomy without losing engineering control.*  
**Технічний підмеседж зберігаємо:** *Run coding agents like infrastructure.*  
**Комерційна логіка незмінна:** Community / Open Source — self-hosted без paywall; Cloud — керована інфраструктура та підтримка; Enterprise — додаткові корпоративні вимоги.


### Єдина розповідь для трьох ролей

**Product teams drive change.** PM визначають продуктову проблему, бажаний результат та критерії приймання. Brownfield-сценарій з AI-чату — головний спосіб продемонструвати цю цінність.

**Engineers define the guardrails.** Інженери встановлюють архітектурні межі, вимоги до якості, versioned workflows, перевірки та людське затвердження. Уже існуючі workflows / `.bellows.yaml` — основа; автоматичні architecture policy checks / risk-based review / golden paths як окремі фічі залишаються можливим roadmap, а не заявою про готовність.

**Bellows does the work.** Агенти працюють у контрольованому середовищі й проходять необхідні перевірки, а люди відповідають за рішення щодо merge та release. MCP — частина open-source поставки Bellows; Cloud монетизує не доступ до нього, а керований сервіс.

Використовуємо цю формулу послідовно на лендингу, демо, презентаціях і discovery. **Це не обіцянка автономного production-deploy чи заміни інженерів.**

## 1. Кому продаємо

**Первинний ICP (гіпотеза):** B2B SaaS / продуктова компанія з **20–50 інженерами**, PM та tech lead/staff engineer, живим GitHub-репозиторієм, CI/тестами та реальним потоком змін у наявному продукті. Команда вже експериментує з Claude Code, OpenCode чи AI-чатами, але не має безпечного стандартизованого шляху від продуктового запиту до готового для перегляду коду.

| Роль | Біль / робота, яку треба зробити | Роль у продажі | Меседж |
| --- | --- | --- | --- |
| **Product Manager / Head of Product** | Хоче реалізовувати невеликі зміни в існуючому продукті, а не лише створювати прототипи. Залежить від ручного handoff до інженерів. | Перший користувач, champion, джерело попиту | «Опиши зміну в AI-чаті. Отримай перевірений PR у справжньому продукті». |
| **CTO** | Хоче збільшити безпечний delivery throughput без нової команди для підтримки agent infrastructure; контролює бюджет і технологічні ризики. | **Economic Buyer (EB), фінальний sponsor/budget owner за нашою ICP-моделлю. Для кожної угоди підтверджуємо право підпису та ліміт витрат.** | «Product autonomy + engineering control. Підключилися — працює. Інфраструктура і support на нас». |
| **Platform / Security Engineering** | Не хоче підтримувати agent executors, оновлення, інциденти, кастомні MCP bridges і нові security risks. | Технічний gatekeeper, партнер у оцінці Cloud TCO | «Одна керована execution-платформа; самостійний хостинг — теж повноцінний шлях». |
| **Staff / Principal Engineer / Tech Lead** | Не хоче бути ручним виконавцем кожної зміни, прагне визначати архітектуру, дозволені межі, checks і review; зараз забагато babysitting агентів. | Технічний champion, owner архітектури й approvals | «Own the architecture. Not every implementation detail». |

**Розподіл ролей у конкретній угоді:** PM може створити попит, але не обов'язково купує. Staff/Tech Lead/Platform, що впливає на CTO, — потенційний **Champion**; перевіряємо активні дії, а не симпатію до демо. **CTO — Economic Buyer** нашого ICP, його участь потрібна до комерційного пілота. На кожному account підтверджуємо фактичну фінансову authority, бюджет та signer (вони іноді відрізняються).

**Кваліфікація ліда:** є наявний продукт і репозиторій; зрозумілий scope змін; CI/test або готовність їх визначити; **інженерний власник архітектурних правил і review**; PM, готовий пройти пілот. Мінімальна одиниця adoption — **пара PM + Engineering**. **Не пріоритет зараз:** чистий greenfield-прототип, команда без owner'а коду, бажання деплоїти без review або регульовані сценарії, де ми ще не можемо довести потрібний compliance.

## 2. Що продаємо

### Головний use case: AI chat → brownfield PR

Сценарій для демонстрації: «Додай bulk refunds до існуючої сторінки Orders. Збережи поточні ролі, правила білінгу та дизайн-систему». Це **не** запит «згенеруй ще один додаток». Це зміна в існуючому продукті з бізнес-правилами, залежностями, тестами та відповідальністю.

1. **Intent.** PM формулює вимогу у звичному AI-чаті.
2. **Connect.** Bellows MCP входить до open-source поставки з коробки та приймає структурований запит і контекст репозиторію; фактичне підключення показуємо після перевірки релізу та сумісності чат-клієнта.
3. **Execute.** Агенти працюють із реальним кодом у контрольованому середовищі.
4. **Verify.** Версійований workflow виконує build, тести, review/fix та задані командою gates.
5. **Return.** PM бачить у чаті статус, висновки, лінк на PR і питання, які потребують людини. Для кожної live-демонстрації перевіряємо наявність цього кроку в релізі. **Жодного auto-merge чи auto-deploy за замовчуванням.**

**Конкурентна рамка.** Greenfield AI app builders корисні для створення нових застосунків і прототипів. Bellows фокусується на іншій задачі: керовані зміни в уже існуючій кодовій базі та інженерному процесі. Це позиціонування/гіпотеза, **не** категорична заява, що конкретні інструменти ніколи не працюють із brownfield.

### Головна історія: Product → Engineering → Bellows

1. **Product teams drive change.** Продакт формулює продуктову проблему, scoped зміни й acceptance criteria. Мета — не прототип, а покращення наявної системи.
2. **Engineers define the guardrails.** Інженери описують repo workflow, тести, review gates та architectural boundaries. Вони фокусуються на архітектурі, складних змінах та рішеннях про реліз — не на кожному UI tweak.
3. **Bellows does the work.** Агенти працюють у контрольованому середовищі, відтворюють стандартизовані перевірки та повертають рев'юваний результат. **Ніхто не обіцяє auto-merge чи заміну людського review.**

**Друга центральна persona — інженер.** Це не просто gatekeeper, а співвласник продуктового досвіду. Його вигода — не більше агентів, а можливість *один раз визначити правила і багато разів безпечно делегувати рутину*.

| Engineering value | Суть | Статус |
| --- | --- | --- |
| **Guardrails as code** | Repo-defined workflows, tests, review stages у `.bellows.yaml` | Існуюча база; автоматичні architecture policy checks — roadmap |
| **Engineering control tower** | Перегляд runs, telemetry, costs, failures, checks | Існуюча база telemetry/dashboard; поглиблення — roadmap |
| **Risk-aware review** | UI copy та зміни billing/permissions потребують різних approval rules | Roadmap / гіпотеза |
| **Golden paths** | Командні API/UI/database patterns, що агенти мають повторно використовувати | Roadmap / гіпотеза |

**Рекомендований демо-сценарій:** PM просить змінити Orders UI; engineer задає дозволені файли, тести, ownership та review; агент проходить workflow, отримує failure за порушення gate, виправляє його й готує PR. **MCP має постачатися з коробки у open source.** Перед live demo перевіряємо сумісний чат-клієнт, фактичний release та end-to-end статус/PR; демонструємо лише перевірені частини. Інженер не просто дивиться фінальний diff: його правила впливають на весь процес.

### Упаковка й монетизація: open core, paid operations

**Принцип:** одна й та сама базова цінність продукту в self-hosted та managed варіанті. **MCP — не paywall.** Комерційний стимул перейти на Cloud — не потреба «розблокувати» чат, а бажання **не утримувати власноруч оркестратор, executors, оновлення, моніторинг і підтримку**.

| Рівень | Що отримує команда | За що платить / статус |
| --- | --- | --- |
| **Community / Self-hosted** | Open-source control plane: workflow orchestration, Docker/Kubernetes execution, quality gates, telemetry. **MCP chat adapter — стандартна можливість open source із коробки**. Команда сама розгортає, оновлює, моніторить і підтримує стек. | **Безкоштовно.** Немає обов'язкової Cloud-підписки чи MCP-пейволу. |
| **Bellows Cloud / Managed** | **Ready-to-run / turnkey:** підключаєш GitHub і чат, обираєш repo/workflow, запускаєш задачі; Bellows бере на себе provisioning, executor runtime, масштабування, оновлення, моніторинг, logs, troubleshooting, операційну підтримку та керування інфраструктурою. Права доступу, repo rules і human approval залишаються у клієнта. | **Платний managed service, early access.** Оплата за зняття операційного навантаження; platform subscription + usage — гіпотеза. SLA, backup/restore, data region, support hours і комерційні commitments — тільки після технічного підтвердження й договору. |
| **Enterprise** | Розширені організаційні можливості поверх managed або, за домовленістю, self-hosted: **SSO/SAML/OIDC, детальні RBAC/permissions, розширений аудит, policies/governance, приватні середовища й контрактний support**. | **Платний корпоративний пакет / roadmap.** Набір і готовність функцій підтверджуємо окремо; SSO та advanced audit ще не заявляємо як реалізовані. |

**Цінність без vendor lock-in.** Технічна команда може залишитися на Community назавжди — це свідомий вибір. Якщо інженери не хочуть обслуговувати runtime й реагувати на інциденти, вони купують Cloud. Якщо потрібні identity, security, audit, procurement та особливі умови підтримки — обговорюють Enterprise. Можливий окремий paid support для self-hosted за контрактом, якщо буде попит.

**Ціна.** Публічного прайсу поки немає. Гіпотеза для Cloud: фіксована плата за керовану платформу/команду **+** execution usage; enterprise-пакет — контрактно. Не прив'язуємо ціну до самої наявності MCP чи кількості чат-користувачів; willingness-to-pay тестуємо за **знятий operational burden**, support/SLA та час до перевіреної зміни. Попередні €99–199 за команду були непідтвердженим орієнтиром — не використовуємо їх у зовнішніх матеріалах.

**Межа обіцянки.** Наявний репозиторій документує Claude Code/OpenCode, remote executors, workflows, quality gates і telemetry. **MCP — визначений стандарт open-source продукту (з коробки, включно з Community); перед демонстрацією або onboarding потрібно перевірити, що відповідний release дійсно опублікований і працює.** Cloud описуємо як turnkey managed experience, але перелік конкретних операційних гарантій підтверджуємо перед contract. Enterprise SSO, advanced audit та granular governance — roadmap, не GA.

## 3. Як маркетуємо

**Три взаємопов'язані маршрути в одну екосистему. У кожному маркетинговому матеріалі показуємо Product intent → Engineering guardrails → Bellows execution; вибір Community/Cloud/Enterprise не змінює core product value.**

**A. PM-led demand generation — головний експеримент.** Контент і founder-led outreach для Head of Product, PM, product-minded founders у brownfield SaaS. Теза «AI prototypes are easy; changing your real product is hard». Демонстрація: одна PM-вимога → реальний repo/workflow → тести → reviewable PR. CTA: **“Explore the AI chat → PR pilot”**. На технічній розмові підключаємо EM/CTO й перевіряємо межі approval. **Варіант впровадження обирає клієнт:** self-hosted або managed Cloud — use case однаковий.

**B. Engineering-led adoption — рівноправний маршрут.** Емоційний меседж: *Own the architecture. Not every implementation detail.* Show real repo gates, review stages and controlled execution, and frame engineers as the designers of automation rather than reviewers of random AI output.

**B. Developer/platform-led trust — другий маршрут.** GitHub, open-source README, quickstart, docs, сценарії `.bellows.yaml`, Claude Code/OpenCode, Docker/Kubernetes, observability, quality gates і MCP із коробки (після перевірки конкретного релізу). Дистрибуція через технічні пости, LinkedIn, Show HN та релевантні developer communities. CTA: **“Self-host Bellows for free”** або **“Let us run it for you”**. Без штучного обмеження open-source можливостей для конверсії.

**C. CTO/platform-led monetization.** Продаємо **не MCP** і не право делегувати задачі: продаємо managed infrastructure, upgrades, operations, incident support і, за підтвердженим попитом, enterprise governance. CTA: **Let us run Bellows**. Інженери можуть назавжди залишитися в Community.

**Контентні теми:** «From prompt to PR in an existing SaaS»; «Why AI prototypes ≠ brownfield changes»; «A PM's request, an engineer's quality gates»; «Build on open source, let Cloud run the infrastructure»; «What it costs to operate your own agent stack»; «SSO, audits and governance for AI workflows» (як roadmap-повідомлення).

**Канали пріоритету:** 1) персональний outbound і теплі introductions до PM + Eng pair; 2) демо й кейси зі згодою design partners; 3) GitHub/open source як повноцінний шлях adoption; 4) developer/platform-контент про build-vs-buy операцій. Paid ads і масштабний SEO — не перший етап.

## 4. Як користувачі стають клієнтами

| PM-led motion | Developer / platform-led motion |
| --- | --- |
| Контент / intro → PM розпізнає brownfield pain | GitHub / технічний контент → self-hosted запуск |
| Discovery: одна конкретна зміна у наявному продукті | Перший робочий workflow на реальному repo |
| Перевірка з Eng owner: repo, CI, дозволи, scope | Команда бачить logs, quality gates та результати |
| Демо / design-partner пілот із review gates | MCP входить у Community із коробки; глибина інтеграції перевіряється за релізом |
| Перший reviewable PR → повторна задача | Виявляються витрати на підтримку executors і orchestration |
| **Вибір:** залишитись self-hosted **або** перейти на платний Cloud | **Вибір:** self-maintained **або** paid managed infrastructure/support |
| Якщо потрібні SSO/advanced audit — Enterprise discovery | Якщо потрібні governance/SSO — Enterprise discovery |

**Момент цінності / activation:** PM отримує корисну зміну в існуючому repo, інженер підтверджує **не лише PR, а й дотримання заздалегідь визначених gates**, і зміна доходить до людського review — **незалежно від Community/Cloud**. **Момент монетизації:** команда свідомо обирає «не займатися інфраструктурою й підтримкою» або потребує Enterprise controls; ми не змушуємо платити за базову MCP-можливість.

**Мінімальний пілот:** один repo, один PM, один Eng owner, **дві зміни різної ризиковості**, визначені gates й approvals, вимір ручного handoff та часу reviewer. Міряємо окремо product value і managed-service value (економія операційних зусиль, бажаний рівень підтримки).

## 5. Перевірка гіпотез і метрики

**North Star (гіпотеза):** частка корисних product changes, які доходять до human review **всередині визначених engineering guardrails** із прийнятною ціною ручної участі. Більше PR без якості — не успіх.

**Що має бути правдою для цього GTM:** (H1) PM хоче керувати реальними змінами з AI-чату; (H2) Eng owner дозволяє це з gates і review; (H3) open-source MCP з коробки зменшує потребу в самописному bridge; (H4) CTO визнає суттєвою вартість і ризик самостійного утримання agent stack; (H5) CTO готовий платити за ready-to-run Cloud та support; (H6) SSO/audit/governance створюють окремий Enterprise попит.

| Що вимірюємо | Сигнал, що варто масштабувати |
| --- | --- |
| Discovery | PM може назвати **конкретну** зміну, repo і поточний ручний handoff; Eng визнає біль. |
| Demand | Частка якісних PM-лідів і зустрічей з Eng sponsor після демо; не лише кліки CTA. |
| Activation | Час від product brief до першого PR для review; частка задач, що проходять gates. |
| Якість | Reviewer acceptance, rework, failures, ролі/permission regressions; порівняння з ручним baseline. |
| **Engineering leverage** | Час інженера на handoff, babysitting, rework та review проти ручного baseline; повторне використання repo rules; violations. |
| **Quality and safety** | Gate pass rate, reviewer acceptance, architectural regressions; throughput без зростання дефектів. |
| **Self-hosted adoption** | Запуски й повторне використання Community; жодного штрафу за відсутність Cloud-конверсії. |
| **Managed conversion** | Частка команд, які просять Cloud через інфраструктуру, підтримку, оновлення й операційні ризики. |
| **Enterprise pull** | Реальні запити на SSO/SAML, advanced audit, support commitments, private environments. |
| **Комерція** | Готовність до **оплачуваного** managed-пілота; контракт за підтримку/операції, не за MCP. |

**Робочі цілі для тесту, не прогнози:** 15–20 інтерв'ю (PM + Eng/CTO), 5 design-partner розмов, 3 контрольовані пілоти (Community та/або Cloud), щонайменше 1 платний managed/support сигнал і 2–3 глибинні інтерв'ю про enterprise requirements. За відсутності сигналів змінюємо пакет/цінність, а не закриваємо MCP у Cloud.

## 6. План на 90 днів

| Час | Продукт / Cloud | GTM / MEDDPICC критерій виходу |
| --- | --- | --- |
| **Дні 1–30** | **Верифікувати MCP out-of-the-box release** (install, permissions, `create task`, status, PR link у реальному chat client); зробити turnkey onboarding path: GitHub → repo → workflow → task. Сформувати Cloud operations checklist і baseline support responsibilities. | 15–20 paired discovery calls, насамперед CTO + Tech Lead/PM. Документувати Pain, baseline Metrics, Champion, CTO access, Decision Criteria. 5 design-partner кандидатів. |
| **Дні 31–60** | Довести «sit down and run»: provisioning, hosted executors, onboarding, upgrades, monitoring, support handoff. Посилити gates/observability; зафіксувати витрати Cloud vs self-host. | 2–3 репозиторні пілоти; отримати **CTO-approved success criteria**, timeline, buyer's Decision Process, compute/support cost baseline. Перевірити willingness to pay за managed ops. |
| **Дні 61–90** | Reliability, limits/cost visibility, security/docs, runbooks; enterprise backlog SSO/audit за реальними requirements. | До 3 завершених пілотів; ≥1 **CTO-sponsored paid managed/support commitment**, process to signature і Paper Process; 1 кейс із дозволу клієнта. Go/no-go на quality + Cloud TCO. |

**Engineering-specific roadmap:** спершу довести існуючі repo workflows/quality gates, далі перевірити попит на architecture policy checks, risk-aware reviewer routing і golden paths. Це не готові Enterprise-only capabilities; майбутні basic guardrails можна розвивати в open source.

**Guardrails пілотів:** дозволені репозиторії й ролі, секрети не йдуть у чат, контрольований executor, budget limits, audit trail, тести з repo, PR замість прямого push у main, merge/deploy тільки після людського рішення. Безпеки не можна «дофейкати» маркетингом.

## 7. Ухвалені рішення і відкриті питання

### Ухвалено засновником

1. **Open-source scope — так.** MCP поставляється **з коробки у Community** разом із базовим workflow engine; не є Cloud-only, per-seat чи licensing paywall. Фактичну версію релізу потрібно перевіряти окремо.
2. **Managed promise — turnkey.** **«Підключив — працює».** Ми надаємо обчислювальну інфраструктуру, deployment, upgrades, scaling, monitoring, операційне обслуговування, support та допомогу з інцидентами. Клієнт визначає repo/permissions/workflows/gates і human review. Не продаємо вигаданих SLA чи zero-risk.
3. **Economic Buyer — CTO.** PM ініціює продуктову задачу; Staff/Tech Lead/Platform впливає на рішення; **CTO** затверджує платний managed service в нашому ICP. В угоді окремо підтверджуємо бюджет, повноваження і signatory.

### Залишилось перевірити

- **M:** який вимірюваний **CTO pain** достатній для paid Cloud? Які baseline self-host ops hours/month, engineer handoff hours, agent-run failures, costs?
- **D/DP:** що має пройти пілот, хто дає engineering/security approval, скільки часу займає CTO's purchase decision?
- **P:** які DPA, security questionnaire, procurement, invoicing, договір та data processing commitments потрібні конкретному account?
- **C:** хто внутрішній Champion, який дійсно приведе нас до CTO й відстоюватиме вибір? Хто конкурує: in-house ops, custom glue, інші toolchains або status quo?
- **Commercial:** перевірити фактичну собівартість Cloud, support load та willingness-to-pay; не фіксувати pricing до перших платних пілотів.

**Рекомендоване рішення:** **Product → Engineering → Bellows** — головна історія adoption. CTO купує **готовий до роботи, керований і підтримуваний сервіс**; Community залишається справжньою self-hosted альтернативою. Paid Cloud — це operational responsibility, не обмеження можливостей MCP.

## 8. MEDDPICC — кваліфікація B2B-угоди

**Метод:** Metrics, Economic Buyer, Decision Criteria, Decision Process, Paper Process, Identify Pain, Champion, Competition. **MEDPIC** використовуємо як скорочення у розмові; для реального продажу CTO/Enterprise зберігаємо всі 8 вимірів, особливо Paper Process і Competition. Фреймворк — спосіб **перевіряти покупця й угоду за доказами**, а не рейтинг готовності Bellows як продукту.

| Літера | Гіпотеза Bellows / уточнено | Що має бути доведено в конкретній угоді |
| --- | --- | --- |
| **M — Metrics** | ① Менше часу від product brief до PR для review; ② менше годин ручного engineering handoff/rework; ③ нижчі витрати на підтримку agent infrastructure й очікуваний TCO Cloud. | **Спільно затверджені CTO baseline і target**, період вимірювання, quality floor (gates, дефекти, review). Жодних вигаданих ROI%. |
| **E — Economic Buyer** | **CTO** — target EB, визначений GTM. Не PM, не випадковий кінцевий користувач. | CTO підтверджує pain, бюджет, commercial owner, готовність підтримати paid pilot і кінцеве рішення; signer/limit verified. |
| **D — Decision Criteria** | Product-to-reviewed-PR, виконання реальних repo checks, людське approval; Cloud onboarding простий, runtime надійний, прозорий usage/cost, підтримка та security. | **Письмовий success scorecard**, узгоджений із CTO + Eng owner, критерії must-have vs nice-to-have; список безпекових вимог і релізної готовності MCP. |
| **D — Decision Process** | PM/Tech Lead champion → technical discovery → security/architecture check → time-boxed pilot → CTO ROI review → paid managed decision. | Реальні учасники, етапи, рішення, дата, veto owners і потрібні approvals у цьому account. |
| **P — Paper Process** | Cloud може вимагати order form, DPA, security assessment, vendor onboarding, invoice/PO, procurement; Enterprise — додаткові legal/security controls. | Хто підписує, які документи, закупівельні пороги, юридичні вимоги та тривалість; **не обіцяти непідтверджені SLA, certifications чи data residency**. |
| **I — Identify / Implicate Pain** | Product changes застрягають у handoff; інженери вручну доглядають агентів; platform витрачає час на runners, upgrades, incidents, custom middleware. | Покупець називає конкретний інцидент/затримку, кого це зачіпає, **вартість бездіяльності** і чому це проблема зараз. |
| **C — Champion** | **Staff/Principal Engineer, Tech Lead або Platform Lead**, підтриманий PM/Head of Product, — найсильніша первинна гіпотеза. | Champion має довіру CTO, власний виграш, допомагає сформувати criteria, приводить до EB і захищає рішення без нас. PM-ентузіазм сам собою не champion. |
| **C — Competition** | **№1: self-hosted Bellows**; №2: DIY agent infrastructure / кастомні bridge; №3: вже оплачені AI coding tools та automation; №4: нічого не змінювати. | Яка реальна альтернатива й хто її просуває? Для Cloud порівнюємо **операційний TCO і відповідальність**, а не штучно обмежуємо OSS. |

### 8.1. Дві окремі фінансові історії

**Product ROI (цінність Bellows загалом).** Порівняти на однакових задачах: baseline час від brief до PR, engineer handoff/rework hours, gate pass rate, reviewer acceptance, production defects. Не рахувати згенеровані LOC чи «кількість агентів» як бізнес-результат.

**Cloud ROI (чому платити замість self-host).** Модель для CTO:

`Monthly self-host TCO = compute + engineer/platform hours × loaded hourly rate + maintenance/upgrades + incident response overhead`

`Monthly managed TCO = Bellows Cloud subscription + metered usage + retained customer-side engineering/approval effort`

Порівнюємо **лише зіставні витрати**; не подвійно враховуємо compute, не прирівнюємо human review до операційної підтримки, не припускаємо нульові витрати на Cloud setup. **CTO купує Cloud лише якщо спрощення операцій, reliability і підтримка виправдовують різницю у вартості.**

### 8.2. Пілот і decision criteria — узгоджувати до початку

**Scope:** 1 real GitHub repo, 1 PM, 1 engineering owner, 1 CTO sponsor; 2 scoped задачі (звичайна й помірно складна, без чутливих payment/PII paths до security review).

**Прийняття:** спільно погоджені перевірки, заборони й human approval; вимір baseline і pilot; перший PR та повторний цикл; документований support/onboarding experience. **Product success ≠ paid Cloud conversion.** Друге потребує доказу, що CTO готовий доручити Bellows ops за гроші.

**Перед paid proposal** отримати від CTO: ① measurable success criteria; ② expected annual/monthly operational spend або budget range; ③ technical / security blockers; ④ кроки ухвалення рішення і дата; ⑤ хто підписує contract.

### 8.3. Правила opportunity qualification

- **Discovery-qualified:** чіткий pain з business impact, target repo і Tech Lead/PM, є кандидат на Champion; відсутність метрик позначена як gap.
- **Pilot-qualified:** CTO access (або погоджена зустріч), decision criteria письмово, Eng owner, scope, контрольований approval process, baseline.
- **Commercial-qualified:** CTO визнав product value **і** managed-service value, погодив paid next step, відомі альтернативи, decision timeline, paper process і signatory.
- **Не прогнозуємо закриття:** без підтвердженого EB access, вимірюваної проблеми, Champion, критеріїв успіху або шляху підписання договору.
- **No-go / defer:** лише greenfield demo без real repo; бажання bypass engineering gates; нездатність виконати security requirements; CTO не бачить потреби платити за operations — такому клієнту **рекомендуємо self-hosted Community**.

### 8.4. П'ять обов'язкових discovery questions

1. **CTO / Pain:** «Скільки інженерного часу зараз йде не на product/architecture, а на ручний agent orchestration, environments, support і дрібні handoffs?»
2. **Metrics:** «Скільки часу типово від чіткої product вимоги до PR, що проходить checks і готовий до review? Які failure/rework rates?»
3. **Criteria:** «Які repo boundaries, approval rules, security controls та operational guarantees зроблять це рішення прийнятним?»
4. **Champion + EB:** «Хто з Engineering реально спонсоруватиме впровадження, і чи може CTO взяти на себе paid Cloud decision після пілота?»
5. **Decision/Paper/Competition:** «З чим ви порівнюєте Cloud — self-host, існуючий stack чи статус-кво? Хто погоджує закупівлю й скільки вона зазвичай триває?»

**Стан на момент GTM 3.1:** підтверджені *продуктові рішення* — MCP out of the box у OSS, turnkey managed Cloud, CTO як target EB. **Не підтверджені фактичними покупцями:** ROI, Champion у конкретному account, decision criteria, buying process, pricing, willingness-to-pay, deal competition і procurement requirements. Це завдання discovery та пілотів, а не припущення.

**Методичний орієнтир:** [MEDDICC — FAQ / MEDDPICC](https://meddicc.com/faqs) (визначення літер і роль Paper Process / Competition).


## 9. Метрики цінності — CTO, Engineering та Product

**Визначення North Star:** не «скільки агентів/рядків/PR створено», а **кількість корисних продуктних змін, які пройшли інженерні перевірки та були прийняті до human review / delivery без погіршення якості, при прийнятному інженерному зусиллі**. Product, Engineering та CTO дивляться на той самий результат крізь різні запитання.

### 9.1. DORA — стратегічні метрики для CTO

Поточна модель DORA — **п'ять** delivery-метрик, розбитих на throughput та instability (див. [DORA software delivery performance metrics](https://dora.dev/guides/dora-metrics/) та [історію п'ятої метрики](https://dora.dev/insights/dora-metrics-history/)).

| CTO outcome / DORA | Точне визначення | Очікуване спрямування | Умови інтерпретації |
| --- | --- | --- | --- |
| **Deployment frequency** | Частота **deployment у production** на один конкретний сервіс / застосунок за тиждень чи місяць | Більше невеликих безпечних змін (якщо це відповідає бізнесу) | Не плутати з релізами фіч або кількістю PR; release cadence іноді визначає бізнес |
| **Change lead time** | Час від **commit до deployment у production** — p50 і p75 | Менше, без падіння якості | **Не** дорівнює часу від PM brief до PR; вимірюємо їх окремо |
| **Change failure rate** | Частка production deployments, що викликали failure/rollback/hotfix | Не збільшується; бажано знижується | Дефекти на 100 deployments або 100 delivered changes; severity зберігати окремо |
| **Failed deployment recovery time** | Час до відновлення після невдалого deployment | Не збільшується | На малих вибірках може не бути інцидентів, не робимо висновків про «нульовий MTTR» |
| **Deployment rework rate** | Частка deployments, які були позаплановими fixes для production bugs | Не збільшується; бажано знижується | П'ята метрика DORA (додано у 2024); не змішувати з PR review fixes |

**Додатково для CTO:** *escape defect density* (дефекти, що дійшли до production, за severity і на нормований обсяг змін), частота rollback, customer-impact incidents. **Сира кількість дефектів не годиться:** при зростанні deployment frequency може змінитися і абсолютне число дефектів, і їх виявлення. Порівнюємо однакові сервіси та класи змін.

### 9.2. Метрики, які Bellows може вплинути швидше — під час пілота

| Роль | Метрика / формула | Дані | Бажаний сигнал |
| --- | --- | --- | --- |
| **Product** | **Brief-to-reviewable-PR lead time** = p50/p75 часу від погоджених acceptance criteria до PR, придатного для human review | Issue / brief timestamp → repo PR timestamp | Зменшується, при незмінній якості |
| **Product** | **Accepted change throughput** = scoped changes / тиждень, що пройшли перевірки і отримали review acceptance | Ticket + GitHub PR + check status | Більше корисної роботи, а не просто створених PR |
| **Engineering** | **Human touch time** = активний час на prompt, handoff, fixing, review, babysitting для однієї зміни | Time sampling або короткий log review effort | Менше повторюваної рутини |
| **Engineering** | **Reviewer rework ratio** = PR, які потребували суттєвої ручної переробки / усі agent-assisted PR | PR review / labels / follow-up commit | Не росте; окремо track reviewer minutes / PR |
| **Engineering** | **Gate pass + policy adherence** = частка runs, що пройшли визначені CI / approval gates, і кількість bypass/architecture violations | CI events, logs, branch protection, audit | **Нуль заборонених bypass**, не обов'язково 100% first-pass tests |
| **Platform/CTO** | **Self-host ops burden** = engineer/platform hours/month для runners, upgrades, monitoring, incidents + compute | On-call, tickets, logs, cloud bills | Відомий baseline для Cloud buy-vs-build |
| **Cloud** | **Time to first value** = від створення account до першого реального repo run із gates; **support cost per customer** | Onboarding timestamps, support tickets, infra billing | Коротший setup; операційно стійка собівартість |

**Класи змін окремо:** UI/copy, звичайна business logic, інтеграції, security/payment/PII (для ризикових завдань не запускаємо пілот без додаткового review). Великі PR та дрібні задачі не порівнюємо одним середнім.

### 9.3. Обмеження атрибуції й дизайн експерименту

- **Baseline:** 4–8 тижнів історичних даних за конкретним repo/service для deployment/review і вручну заміряний або оцінений touch time; бажано порівняти схожі категорії завдань.
- **Pilot:** 2–4 тижні, 1 repo, PM + Engineering owner + CTO sponsor, декілька типових scoped changes. Виміряти brief-to-PR, reviewer minutes, gates, rework, setup/support.
- **Post-pilot:** DORA і escaped defects — **лагові**, для висновків потрібні більша кількість deployments, достатній період та контроль інших змін. Не стверджуємо «Bellows зменшив production defects» після двох PR.
- **Guardrails:** speed/throughput ніколи не розглядаються без stability, human approval, security і engineering effort. Зростання review queue чи severity defects — **stop/rework pilot**.
- **Приклад success criteria (лише переговорні цілі, не результати):** у пілоті brief-to-PR p50 коротший на 20%+, engineer manual touch/PR зменшився на 20%+, всі зафіксовані gates виконані, немає bypass. CTO має **узгодити власні пороги до запуску**, а не прийняти наші як industry standard.
- **Не KPI для бонусів окремих інженерів:** рядки коду, кількість промптів/агентів, кількість PR, відсоток «AI generated» або deploys/day як самоціль. DORA застерігає від одиночних метрик і неконтекстного порівняння між командами.

**Чому guardrails — ключове повідомлення:** DORA 2025 зауважив, що вищий AI adoption може підвищувати throughput, але погіршувати stability без сильних системних перевірок. Це **не доказ ефекту Bellows**, а аргумент, чому оцінювати продукт потрібно за спільним throughput + instability + human effort ([2025 DORA report](https://dora.dev/research/2025/dora-report/), [DORA 2026: balancing AI tensions](https://dora.dev/insights/balancing-ai-tensions/)).

### 9.4. MEDDPICC-M: що показуємо CTO

До комерційного пілота збираємо **два окремі business cases**:
1. **Бізнес / engineering productivity:** скорочення brief-to-reviewed-PR часу та manual touch hours, accepted throughput, стабільна якість і review workload.
2. **Managed Cloud buy-vs-build:** self-host TCO (compute + maintenance + upgrades + troubleshooting + інциденти + engineer time) проти Cloud subscription/usage + retained customer-side engineering work.

**Потенційна грошова оцінка, тільки на основі customer baseline:** години ручного orchestration, вивільнені для architecture/product × loaded hourly rate; додатково *не* припускати, що всі вивільнені години автоматично конвертуються в дохід. CTO повинен підтвердити, що зекономлений час має реальну цінність.

## 10. Робота із запереченнями, якщо продаємо напряму Product / бізнесу

### 10.1. Головне правило маршруту

**Business-led introduction ≠ engineering bypass.** Сильна історія: Product/CEO/CPO відкриває розмову через проблему delivery speed → CTO **Economic Buyer** та owner бюджету в нашому ICP → Engineering/Staff Engineer визначає *technical acceptance, security constraints, code ownership* → Bellows виконує роботу лише в затверджених межах.

**Не кажемо:** «Продакт більше не потребує розробників», «відтепер кожен пушить зміни в production» чи «технічна команда — гальмо бізнесу». **Кажемо:** «Продакти можуть ініціювати зміни; інженери один раз задають стандарти і залишаються власниками approve/merge/release. Bellows бере на себе повторювану реалізацію».

Якщо ініціатор — CPO/CEO й саме він має фактичну фінальну бюджетну владу, MEDDPICC **Economic Buyer для конкретної угоди треба оновити**: CTO залишається критичним technical approver/sponsor, але не вигадуємо його повноваження.

### 10.2. CTO objections — відповідь і перевірка доказами

| Заперечення CTO | Як відповідаємо | Що доводимо / пропонуємо |
| --- | --- | --- |
| **«Це shadow IT: бізнес обійде Engineering»** | «Ні. PM задає intent, але code owners задають repo scope, CI gates, права та обов'язковий human approval. Bellows не отримує право обходити merge/release». | Живий PR без push у main, mandatory checks, branch protection, право Engineering зупинити run |
| **«AI-код додасть дефектів і technical debt»** | «Ми не просимо повірити в якість AI; порівняємо reviewer effort, rework, DORA stability та defect escape із baseline. Pilot зупиняємо, якщо стабільність погіршується». | Тести, review log, окреме вимірювання escaped defects та gate bypass |
| **«Інфраструктура і доступ до коду небезпечні»** | «Інженери визначають доступи, execution boundary і дозволені репозиторії. Для Cloud обговорюємо secrets, retention, data flows і support до підключення». | Security walkthrough, мінімальні permissions, code/data boundary, юридичні документи; не заявляємо непідтверджені certifications |
| **«Навіщо Cloud, якщо open source безкоштовний?»** | «Можна self-host назавжди. Cloud — це коли ви не хочете утримувати runners, оновлення, моніторинг, incident response та підтримку». | Чесний Cloud vs self-host TCO, time-to-first-run, support scope |
| **«Ми вже використовуємо Cursor/Claude Code»** | «Bellows не конкурує за інтерфейс editor/chat або модель. Він стандартизує запуск, перевірки, передачу контексту і результат на рівні команди». | Демо поверх наявних інструментів, не вимагаємо міграції coding assistant |
| **«Занадто рано, MCP/Cloud/SSO ще нестабільні»** | «У пілот беремо тільки перевірену версію й чітко узгоджений scope; не підмінюємо production гарантії roadmap». | Release + install check MCP, Cloud pilot scope, transparent roadmap / security blockers |
| **«Тепер відповідальність за quality розмита»** | «Власник рішення не змінюється. Engineering визначає gates і reviewer, приймає PR, дає approval на merge/release; Bellows лише виконує workflow». | RACI, audit trail та чітке право вето engineering |

### 10.3. Engineer / Staff Engineer objections

| Заперечення | Відповідь | Перевірка |
| --- | --- | --- |
| **«Нас хочуть замінити, PM буде писати код без нас»** | «Роль інженера стає більш архітектурною: ви визначаєте правила, boundaries та приймаєте результат. Ми прибираємо рутинний handoff, не engineering ownership». | Технічний co-design пілота із senior engineer; не позиціонуємо інженерів як bottleneck |
| **«Мені доведеться лагодити весь згенерований код»** | «Це головний ризик пілота. Вимірюємо reviewer minutes/PR, rework, CI failures. Якщо ручна робота росте — pilot неуспішний». | Порівнянні задачі, baseline review/repair effort, stop rule |
| **«Агенти не розуміють нашу архітектуру / brownfield»** | «Не очікуємо магії. Використовуємо реальний repo, версіонований workflow, checks і scoped changes. Розширені architecture policies / golden paths — окремі roadmap, не підміняємо ними поточні можливості». | Невелика реальна brownfield задача, boundary checks і review |
| **«Новий platform layer — ще один сервіс, який підтримувати»** | «Для self-host це свідомий trade-off; Cloud бере runtime, upgrades і monitoring на себе». | Умови support, реальний onboarding, support ownership |
| **«Ми втратимо контроль / можна буде обійти approvals»** | «Код і merge залишаються під наявними branch protection, CI і code owners. Human review не опція, яку бізнес може вимкнути». | Реальна заборона merge/bypass, restricted repo permissions, kill switch / rollback plan (якщо підтримується) |
| **«Навіщо нам вірити демо?»** | «Не треба: запускаємо на вашому обмеженому repo із вашими тестами, документуємо результати та інциденти; якщо не працює — не розгортаємо». | Двосторонній pilot scorecard і прозорі logs |

### 10.4. Заперечення бізнесу під час direct sales

- **«Чому не зробити все в Lovable / іншому AI builder?»** — «Greenfield prototype добре доводить ідею. Якщо потрібно змінити існуючу систему, потрібно врахувати справжні permissions, тести, code owner і delivery процес. Bellows спеціалізується на цьому. Не стверджуємо, що всі інші продукти не вміють brownfield».
- **«Чому інженери все одно потрібні?»** — «Тому що без architecture, quality gates і accountability швидке написання коду не означає безпечну доставку змін. Ви отримуєте менше ручних handoff, не відсутність Engineering».
- **«Коли можна дозволити PM запускати зміни?»** — «Після короткого co-design із CTO/Engineering: whitelist repositories, scopes, tests, approval rules, human review. Перші задачі — low-risk».
- **«Чому ми маємо платити?»** — «Щоб отримати turnkey-систему без своєї команди інфраструктури AI-агентів. Якщо хочете самі обслуговувати, Community справді безкоштовний».
- **«Як швидко побачимо business value?»** — «Погодимо baseline, success criteria і real repo pilot. Не обіцяємо конкретний відсоток speedup без даних».

### 10.5. Покроковий sales motion без конфлікту

1. **Business meeting:** CPO/PM/CEO формулює конкретне невдоволення швидкістю змін; не обіцяємо deploy без Engineering.
2. **Joint problem framing:** залучаємо CTO і Staff/Tech Lead, записуємо gates, риски, доступи, reviewer та acceptance criteria. CTO знає, хто і що ініціюватиме.
3. **Mutual action plan:** критерії успіху за Product + Engineering + Cloud/TCO, дата review, власники blockers і Paper Process. Без technical sign-off не запускаємо пілот.
4. **Pilot:** один repo, low-risk changes, чітка ізоляція, PR та human review; вимірюємо touch time і rework. Kill switch/rollback тільки якщо технічно доступні та перевірені.
5. **CTO decision:** demo результатів, quality floor, self-host vs managed TCO, roadmap gaps та security review; **CTO купує operations**, а не право бізнесу обійти engineers.

**Основна sales-фраза:** *“Product teams request the change. Engineers stay in charge of how it’s built and approved. Bellows handles the execution. Cloud handles the operations.”*

### 10.6. MEDDPICC qualification для direct-business входу

- **M / Pain:** business delay + engineering toil + Cloud operations cost у тих самих scoped changes.
- **E:** CTO як цільовий Economic Buyer; перевірити authority, особливо якщо перша розмова йшла із CEO/CPO.
- **D:** окремі критерії Product (швидкість), Engineering (безпека), CTO (TCO/reliability), Security (permissions/data), Legal (paper).
- **Champion:** бізнес-ентузіаст сам по собі недостатній. Потрібен **Engineering Champion**, який має довіру CTO. Не намагаємось перетворити технічний veto на політичний конфлікт.
- **Competition:** не лише інші постачальники; CTO може вирішити залишити full self-host, поточний toolchain, DIY middleware або status quo.
- **Deal warning:** CTO або code owner не має доступу до обговорення; business наполягає на bypass approvals; «пілот» вимірює тільки кількість PR; Cloud support/security scope невизначений.

*Методичні джерела: [DORA metrics](https://dora.dev/guides/dora-metrics/), [DORA 2025](https://dora.dev/research/2025/dora-report/), [DORA on AI tensions](https://dora.dev/insights/balancing-ai-tensions/) та [MEDDPICC FAQ](https://meddicc.com/faqs).*

---

*Версія 3.2 (MEDDPICC + Metrics + Direct-business objections), 24 жовтня 2026. Рішення засновника: MCP з коробки у Community, Cloud ready-to-run / managed operations, CTO — Economic Buyer. Business metrics, ціни, Enterprise roadmap та sales evidence залишаються гіпотезами до customer validation.*