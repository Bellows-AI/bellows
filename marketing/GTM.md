# Bellows — Go-to-Market 2.0

**Стратегічний документ • Жовтень 2026 • Робоча версія для ухвалення рішень**  
**Тема:** Bellows Cloud як міст від AI-чату до змін у наявному продукті (brownfield software).

> **Your AI chat. Your real codebase.**  
> From product idea to reviewed PR — without leaving the conversation.

**Теза.** Перестаємо продавати «оркестрацію агентів» як головну цінність. Продаємо результат: product manager може ініціювати зміну в наявній системі зі свого AI-чату, а Bellows запускає інженерний цикл у реальному репозиторії — від задачі та середовища до перевірок і PR для людського review. **MCP-інтеграція з чатом — запланований Cloud-сценарій, а не доступна зараз функція.** Наявний open-source control plane — технічна основа обіцянки.

**Нова формула зростання:** *Product teams initiate. Engineering teams govern. Companies pay.*  
**Технічний бренд-меседж зберігаємо:** *Run coding agents like infrastructure.*

## 1. Кому продаємо

**Первинний ICP (гіпотеза):** B2B SaaS / продуктова компанія з **20–50 інженерами**, щонайменше одним PM, живим GitHub-репозиторієм, CI/тестами та реальним потоком змін у наявному продукті. Команда вже експериментує з Claude Code, OpenCode чи AI-чатами, але не має безпечного стандартизованого шляху від продуктового запиту до готового для перегляду коду.

| Роль | Біль / робота, яку треба зробити | Роль у продажі | Меседж |
| --- | --- | --- | --- |
| **Product Manager / Head of Product** | Хоче реалізовувати невеликі зміни в існуючому продукті, а не лише створювати прототипи. Залежить від ручного handoff до інженерів. | Перший користувач, champion, джерело попиту | «Опиши зміну в AI-чаті. Отримай перевірений PR у справжньому продукті». |
| **CTO / VP Engineering / EM** | Потребує контролю якості, навантаження, доступів і відповідальності за AI-зміни. | Economic buyer, спонсор пілота | «Дайте продукту швидкість, не втрачаючи engineering governance». |
| **Platform / Security Engineering** | Не хоче підтримувати десятки самописних bridge/middleware інтеграцій. | Технічний gatekeeper | «Одна контрольована execution-платформа, repo-defined workflows, ізоляція та видимість». |
| **Developers / AI power users** | Керують агентами вручну; результат залежить від локального оточення та людини. | Adopter, reviewer, внутрішній адвокат | «Автономна робота агентів із тестами, review та зрозумілим handoff». |

**Кваліфікація ліда:** є наявний продукт і репозиторій; зрозумілий scope змін; CI/test або готовність їх визначити; технічний власник review; PM, готовий пройти пілот. **Не пріоритет зараз:** чистий greenfield-прототип, команда без owner'а коду, бажання деплоїти без review або регульовані сценарії, де ми ще не можемо довести потрібний compliance.

## 2. Що продаємо

### Головний use case: AI chat → brownfield PR

Сценарій для демонстрації: «Додай bulk refunds до існуючої сторінки Orders. Збережи поточні ролі, правила білінгу та дизайн-систему». Це **не** запит «згенеруй ще один додаток». Це зміна в існуючому продукті з бізнес-правилами, залежностями, тестами та відповідальністю.

1. **Intent.** PM формулює вимогу у звичному AI-чаті.
2. **Connect (планується).** Bellows MCP отримує структурований запит і контекст репозиторію.
3. **Execute.** Агенти працюють із реальним кодом у контрольованому середовищі.
4. **Verify.** Версійований workflow виконує build, тести, review/fix та задані командою gates.
5. **Return (планується).** PM бачить у чаті статус, висновки, лінк на PR і питання, які потребують людини. **Жодного auto-merge чи auto-deploy за замовчуванням.**

**Конкурентна рамка.** Greenfield AI app builders корисні для створення нових застосунків і прототипів. Bellows фокусується на іншій задачі: керовані зміни в уже існуючій кодовій базі та інженерному процесі. Це позиціонування/гіпотеза, **не** категорична заява, що конкретні інструменти ніколи не працюють із brownfield.

### Упаковка й монетизація

| Рівень | Що пропонуємо | Як заробляємо / статус |
| --- | --- | --- |
| **Community** | Відкрита self-hosted платформа: workflow orchestration, Docker/Kubernetes execution, спостережуваність; технічна довіра й developer adoption. | **Безкоштовно**, open source. Поточна основа продукту. |
| **Bellows Cloud** | Керований workflow + execution + onboarding; головний майбутній диференціатор — MCP entry/feedback loop в AI-чаті для product teams. | **Early access / пілоти.** Гіпотеза: platform fee за команду/workspace **+** usage/execution. Термін і обсяг погоджуємо окремо. |
| **Enterprise** | SSO/RBAC, розширений audit/governance, приватне розгортання, контрактний support — тільки після валідації вимог. | **Майбутня гіпотеза**, не поточна обіцянка. |

**Ціна.** Попередній орієнтир €99–199 / команда / місяць + execution costs був **неперевіреною гіпотезою**. Для managed Cloud з business-critical brownfield workflow це може бути замалим як ціновий якір. Не публікуємо прайс до перевірки willingness-to-pay; на інтерв'ю тестуємо різні пакетні пропозиції й оплачувані пілоти. Продаємо не кількість agent sessions, а контрольований *time-to-reviewed-change*.

**Межа обіцянки.** Open source вже документує агентів Claude Code/OpenCode, кероване виконання, workflows, перевірки, телеметрію та людський контроль. Chat-facing MCP, повернення артефактів у чат, Cloud packaging і SLA — **roadmap/гіпотези**, не GA. На сайті та в демо це позначаємо як *coming to Cloud / early access*.

## 3. Як маркетуємо

**Два маршрути в один Cloud-продукт; на перші 90 днів пріоритет — product-led wedge.**

**A. PM-led demand generation — головний експеримент.** Контент і founder-led outreach для Head of Product, PM, product-minded founders у brownfield SaaS. Теза «AI prototypes are easy; changing your real product is hard». Демонстрація на правдоподібному існуючому репозиторії: одна PM-вимога → workflow → перевірки → reviewable PR. CTA: **“Join the AI chat → PR pilot”**. На першій технічній розмові підключаємо EM/CTO і перевіряємо approval boundaries.

**B. Developer/platform-led trust — другий маршрут.** GitHub, open-source README, quickstart, docs, сценарії `.bellows.yaml`, Claude Code/OpenCode, Docker/Kubernetes, observability, quality gates. Дистрибуція через технічні пости, LinkedIn, Show HN та релевантні developer communities. CTA: **“Run Bellows yourself”** або **“Discuss managed Cloud”**. Не підмінюємо продуктову історію лише Kubernetes-архітектурою.

**Контентні теми:** «From prompt to PR in an existing SaaS»; «Why AI prototypes ≠ brownfield changes»; «A PM's request, an engineer's quality gates»; «How to let agents work without giving them deploy access»; «Why teams keep building custom AI middleware — and what a shared control plane replaces».

**Канали пріоритету:** 1) персональний outbound і теплi introductions до PM + Eng pair; 2) демо й короткі кейси зі згодою design partners; 3) GitHub/open source як proof; 4) developer marketing. Paid ads і масштабний SEO — не перший етап.

## 4. Як користувачі стають клієнтами

| PM-led commercial motion | Developer-led motion |
| --- | --- |
| Контент / intro → PM розпізнає brownfield pain | GitHub / технічний контент → self-hosted запуск |
| 20-хв discovery: одна конкретна зміна | Перший workflow на репозиторії |
| Перевірка з Eng owner: repo, CI, дозволи, scope | Повторне використання та показ результатів команді |
| Demo / design-partner пилот з чітким review gate | Обговорення managed execution і Cloud |
| Перший reviewable PR → повторна задача | Командний rollout, governance та підтримка |
| Оплачуваний Bellows Cloud pilot → контракт | Bellows Cloud / пізніше Enterprise |

**Момент цінності / activation:** не «агент запущено», а **PM отримав корисну зміну в наявному репозиторії, інженер підтвердив quality gates, і PR дійшов до людського review**. Мірою успіху є *reviewable change*, а не згенеровані рядки коду.

**Мінімальний пілот:** один репозиторій, один PM, один Eng owner, одна зміна з обмеженим scope, визначені тести і чітка межа безпеки. Критерії успіху погоджуємо до початку; інтеграції, яких ще немає, не видаємо за готові.

## 5. Перевірка гіпотез і метрики

**Що має бути правдою для цього GTM:** (H1) PM справді хоче керувати реальними змінами з AI-чату; (H2) Eng owner дозволяє це за наявності gates і review; (H3) Cloud знімає більше болю, ніж самописний middleware; (H4) хтось із покупців має бюджет і готовий платити; (H5) MCP UX не руйнує контекст, статуси й handoff.

| Що вимірюємо | Сигнал, що варто масштабувати |
| --- | --- |
| Discovery | PM може назвати **конкретну** зміну, repo і поточний ручний handoff; Eng визнає біль. |
| Demand | Частка якісних PM-лідів і зустрічей з Eng sponsor після демо; не лише кліки CTA. |
| Activation | Час від product brief до першого PR для review; частка задач, що проходять gates. |
| Якість | Reviewer acceptance, rework, failures, ролі/permission regressions; порівняння з ручним baseline. |
| Комерція | Повторний запуск іншої задачі та готовність до **оплачуваного** Cloud-пілота. |

**Робочі цілі для тесту, не прогнози:** 15–20 інтерв'ю (PM + Eng/CTO), 5 кваліфікованих design-partner розмов, 3 контрольовані пілоти, щонайменше 1 підтверджена оплата або письмове комерційне зобов'язання. За відсутності таких сигналів — переглянути wedge, а не автоматично збільшувати маркетинговий бюджет.

## 6. План на 90 днів

| Час | Продукт | GTM і критерій виходу |
| --- | --- | --- |
| **Дні 1–30** | Специфікація MCP contract: `create task`, `status`, `artifacts / PR`, `review requests`; модель permissions, sandbox, audit. Демо поточного Bellows workflow без імітації реальної MCP-роботи. | 15–20 paired discovery calls; PM-first лендинг і заявка на chat pilot; зібрати 5 чітких brownfield задач. |
| **Дні 31–60** | Тонкий MCP-адаптер для **одного** сумісного чат-клієнта; зв'язок із task API; статус, review і PR link назад у чат. Без auto-merge/deploy. | 2–3 керовані demo/pilot sessions; зафіксувати success criteria; перевірити buyer, security objections і willingness-to-pay. |
| **Дні 61–90** | Надійність виконання, cost controls, authorization та повторюваний onboarding у Cloud. Підтвердити відтворюваність на другій задачі й іншому repo. | 3 design-partner pilots; щонайменше 1 paid signal; перша публічна історія зі згодою клієнта. Рішення go/no-go за результатами. |

**Guardrails пілотів:** дозволені репозиторії й ролі, секрети не йдуть у чат, контрольований executor, обмеження бюджету, audit trail, перевірки з репозиторію, PR замість прямого пушу в main, рішення merge/deploy лише людиною.

## 7. Питання для стратегічного рішення

1. **Один wedge:** чи обираємо PM → AI chat → existing codebase → reviewed PR як головний вхід на наступні 90 днів?
2. **Покупець:** хто підписує контракт — CTO/VP Engineering, Head of Product чи спільний бюджет innovation/engineering?
3. **Мінімальний MCP:** який перший сумісний чат і який найкоротший замкнений цикл, що реально працює (не demo-only)?
4. **Пілотний guardrail:** який клас задач дозволяємо PM створювати без участі інженера **до** запуску, а де потрібне попереднє схвалення?
5. **Commercial packaging:** platform fee + usage чи ціна за окремий керований product team; що підтверджує готовність платити?

**Рекомендоване рішення:** 90 днів перевіряємо PM-led brownfield wedge, залишаючи open-source/developer motion джерелом adoption і довіри. Bellows Cloud — головна комерційна пропозиція; Enterprise — лише майбутня гіпотеза. Не продаємо «магічну автоматичну доставку в production». Продаємо **замкнений, контрольований цикл до перевіреного PR**.

---

*Переосмислено на основі вихідного «Bellows — Go-to-Market» (аудиторії, Community / Cloud / Enterprise, open source, founder-led sales, design partners і два шляхи конверсії). Нове: PM-first brownfield wedge, MCP chat experience як roadmap, buyer/champion distinction, пілотні guardrails, activation та 90-денний план. Усі числові орієнтири, ціни й roadmap — внутрішні припущення, не підтверджені ринкові дані.*
