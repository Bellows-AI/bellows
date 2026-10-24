# Bellows — Go-to-Market 2.1

**Стратегічний документ • Жовтень 2026 • Робоча версія для ухвалення рішень**  
**Тема:** Bellows як open-source міст від AI-чату до змін у наявному продукті; Bellows Cloud та Enterprise — платні інфраструктура, експлуатація й підтримка.

> **Product teams drive change. Engineers define the guardrails. Bellows does the work.**  
> Your AI chat. Your real codebase. From product idea to reviewed PR — without leaving the conversation.

**Теза.** Продаємо результат: product manager може ініціювати зміну в наявній системі зі свого AI-чату, а Bellows запускає інженерний цикл у реальному репозиторії — від задачі та середовища до перевірок і PR для людського review. **MCP-інтеграція має бути частиною open-source можливостей Bellows (планується, ще не доступна як готовий chat-to-PR сценарій).** Cloud не продає доступ до MCP: Cloud продає інфраструктуру, надійну експлуатацію, оновлення та підтримку. Хто хоче самостійно хостити й підтримувати Bellows — може робити це без підписки.

**Головний бренд-слоган:** *Product teams drive change. Engineers define the guardrails. Bellows does the work.*  
**Use-case повідомлення:** *Your AI chat. Your real codebase.*  
**Технічний підмеседж зберігаємо:** *Run coding agents like infrastructure.*  
**Комерційна логіка незмінна:** Community / Open Source — self-hosted без paywall; Cloud — керована інфраструктура та підтримка; Enterprise — додаткові корпоративні вимоги.


### Єдина розповідь для трьох ролей

**Product teams drive change.** PM визначають продуктову проблему, бажаний результат та критерії приймання. Brownfield-сценарій з AI-чату — головний спосіб продемонструвати цю цінність.

**Engineers define the guardrails.** Інженери встановлюють архітектурні межі, вимоги до якості, versioned workflows, перевірки та людське затвердження. Уже існуючі workflows / `.bellows.yaml` — основа; автоматичні architecture policy checks / risk-based review / golden paths як окремі фічі залишаються можливим roadmap, а не заявою про готовність.

**Bellows does the work.** Агенти працюють у контрольованому середовищі й проходять необхідні перевірки, а люди відповідають за рішення щодо merge та release. Майбутній MCP адаптер має бути доступним і в open source; Cloud монетизує не доступ до нього, а експлуатацію.

Використовуємо цю формулу послідовно на лендингу, демо, презентаціях і discovery. **Це не обіцянка автономного production-deploy чи заміни інженерів.**

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

### Упаковка й монетизація: open core, paid operations

**Принцип:** одна й та сама базова цінність продукту в self-hosted та managed варіанті. **MCP — не paywall.** Комерційний стимул перейти на Cloud — не потреба «розблокувати» чат, а бажання **не утримувати власноруч оркестратор, executors, оновлення, моніторинг і підтримку**.

| Рівень | Що отримує команда | За що платить / статус |
| --- | --- | --- |
| **Community / Self-hosted** | Open-source control plane: workflow orchestration, Docker/Kubernetes execution, quality gates, telemetry. **MCP-адаптер для чатів також планується у відкритій версії**. Команда сама розгортає, оновлює, моніторить і підтримує стек. | **Безкоштовно.** Немає обов'язкової Cloud-підписки чи MCP-пейволу. |
| **Bellows Cloud / Managed** | Ті самі core/workflow/MCP-можливості + розгортання та експлуатація як сервіс: керована інфраструктура виконання, оновлення, моніторинг, операційна підтримка, onboarding, допомога з інцидентами. | **Платний managed service, early access.** Тестуємо platform subscription + фактичне використання compute; обсяг/SLA узгоджуємо в пілоті. |
| **Enterprise** | Розширені організаційні можливості поверх managed або, за домовленістю, self-hosted: **SSO/SAML/OIDC, детальні RBAC/permissions, розширений аудит, policies/governance, приватні середовища й контрактний support**. | **Платний корпоративний пакет / roadmap.** Набір і готовність функцій підтверджуємо окремо; SSO та advanced audit ще не заявляємо як реалізовані. |

**Цінність без vendor lock-in.** Технічна команда може залишитися на Community назавжди — це свідомий вибір. Якщо інженери не хочуть обслуговувати runtime й реагувати на інциденти, вони купують Cloud. Якщо потрібні identity, security, audit, procurement та особливі умови підтримки — обговорюють Enterprise. Можливий окремий paid support для self-hosted за контрактом, якщо буде попит.

**Ціна.** Публічного прайсу поки немає. Гіпотеза для Cloud: фіксована плата за керовану платформу/команду **+** execution usage; enterprise-пакет — контрактно. Не прив'язуємо ціну до самої наявності MCP чи кількості чат-користувачів; willingness-to-pay тестуємо за **знятий operational burden**, support/SLA та час до перевіреної зміни. Попередні €99–199 за команду були непідтвердженим орієнтиром — не використовуємо їх у зовнішніх матеріалах.

**Межа обіцянки.** Наявний open-source репозиторій документує Claude Code/OpenCode, віддалені executors, workflows, перевірки й telemetry. **MCP chat integration, повернення результатів у чат, повноцінна managed Cloud-пропозиція та enterprise-функції (SSO, advanced audit) — roadmap/пілотні гіпотези, не GA.** Статус функції не залежить від ліцензійної межі: MCP планується для open source, а не тільки для Cloud.

## 3. Як маркетуємо

**Два маршрути в одну екосистему (Community → опціонально Cloud / Enterprise); на перші 90 днів пріоритет — product-led wedge.**

**A. PM-led demand generation — головний експеримент.** Контент і founder-led outreach для Head of Product, PM, product-minded founders у brownfield SaaS. Теза «AI prototypes are easy; changing your real product is hard». Демонстрація: одна PM-вимога → реальний repo/workflow → тести → reviewable PR. CTA: **“Explore the AI chat → PR pilot”**. На технічній розмові підключаємо EM/CTO й перевіряємо межі approval. **Варіант впровадження обирає клієнт:** self-hosted або managed Cloud — use case однаковий.

**B. Developer/platform-led trust — другий маршрут.** GitHub, open-source README, quickstart, docs, сценарії `.bellows.yaml`, Claude Code/OpenCode, Docker/Kubernetes, observability, quality gates і в майбутньому відкритий MCP bridge. Дистрибуція через технічні пости, LinkedIn, Show HN та релевантні developer communities. CTA: **“Self-host Bellows for free”** або **“Let us run it for you”**. Без штучного обмеження open-source можливостей для конверсії.

**Контентні теми:** «From prompt to PR in an existing SaaS»; «Why AI prototypes ≠ brownfield changes»; «A PM's request, an engineer's quality gates»; «Build on open source, let Cloud run the infrastructure»; «What it costs to operate your own agent stack»; «SSO, audits and governance for AI workflows» (як roadmap-повідомлення).

**Канали пріоритету:** 1) персональний outbound і теплі introductions до PM + Eng pair; 2) демо й кейси зі згодою design partners; 3) GitHub/open source як повноцінний шлях adoption; 4) developer/platform-контент про build-vs-buy операцій. Paid ads і масштабний SEO — не перший етап.

## 4. Як користувачі стають клієнтами

| PM-led motion | Developer / platform-led motion |
| --- | --- |
| Контент / intro → PM розпізнає brownfield pain | GitHub / технічний контент → self-hosted запуск |
| Discovery: одна конкретна зміна у наявному продукті | Перший робочий workflow на реальному repo |
| Перевірка з Eng owner: repo, CI, дозволи, scope | Команда бачить logs, quality gates та результати |
| Демо / design-partner пілот із review gates | MCP-адаптер, коли з'явиться, доступний також у open source |
| Перший reviewable PR → повторна задача | Виявляються витрати на підтримку executors і orchestration |
| **Вибір:** залишитись self-hosted **або** перейти на платний Cloud | **Вибір:** self-maintained **або** paid managed infrastructure/support |
| Якщо потрібні SSO/advanced audit — Enterprise discovery | Якщо потрібні governance/SSO — Enterprise discovery |

**Момент цінності / activation:** PM отримує корисну зміну в існуючому repo, інженер підтверджує gates і PR доходить до людського review — **незалежно від Community/Cloud**. **Момент монетизації:** команда свідомо обирає «не займатися інфраструктурою й підтримкою» або потребує Enterprise controls; ми не змушуємо платити за базову MCP-можливість.

**Мінімальний пілот:** один repo, один PM, один Eng owner, одна зміна з обмеженим scope, тести та межі безпеки. Міряємо окремо product value і managed-service value (економія операційних зусиль, бажаний рівень підтримки).

## 5. Перевірка гіпотез і метрики

**Що має бути правдою для цього GTM:** (H1) PM хоче керувати реальними змінами з AI-чату; (H2) Eng owner дозволяє це з gates і review; (H3) open-source MCP зменшує потребу в самописному bridge; (H4) компанії готові платити за операційну простоту Cloud та підтримку, а не за доступ до MCP; (H5) SSO/audit/governance створюють окремий Enterprise попит.

| Що вимірюємо | Сигнал, що варто масштабувати |
| --- | --- |
| Discovery | PM може назвати **конкретну** зміну, repo і поточний ручний handoff; Eng визнає біль. |
| Demand | Частка якісних PM-лідів і зустрічей з Eng sponsor після демо; не лише кліки CTA. |
| Activation | Час від product brief до першого PR для review; частка задач, що проходять gates. |
| Якість | Reviewer acceptance, rework, failures, ролі/permission regressions; порівняння з ручним baseline. |
| **Self-hosted adoption** | Запуски й повторне використання Community; жодного штрафу за відсутність Cloud-конверсії. |
| **Managed conversion** | Частка команд, які просять Cloud через інфраструктуру, підтримку, оновлення й операційні ризики. |
| **Enterprise pull** | Реальні запити на SSO/SAML, advanced audit, support commitments, private environments. |
| **Комерція** | Готовність до **оплачуваного** managed-пілота; контракт за підтримку/операції, не за MCP. |

**Робочі цілі для тесту, не прогнози:** 15–20 інтерв'ю (PM + Eng/CTO), 5 design-partner розмов, 3 контрольовані пілоти (Community та/або Cloud), щонайменше 1 платний managed/support сигнал і 2–3 глибинні інтерв'ю про enterprise requirements. За відсутності сигналів змінюємо пакет/цінність, а не закриваємо MCP у Cloud.

## 6. План на 90 днів

| Час | Продукт | GTM і критерій виходу |
| --- | --- | --- |
| **Дні 1–30** | Специфікація **open-source MCP** contract: `create task`, `status`, `artifacts / PR`, `review requests`; модель permissions, sandbox, audit events. Визначити мінімальний Cloud operations package окремо від можливостей MCP. | 15–20 paired discovery calls; PM-first лендинг із чесним вибором Community/Cloud; перевірити, за яку експлуатаційну роботу платитимуть. |
| **Дні 31–60** | Опублікувати MCP-адаптер у open-source Bellows для **одного** сумісного чат-клієнта; статус і PR link назад у чат. Окремо налагодити кероване середовище Cloud, оновлення, моніторинг, support loop. | 2–3 пілоти на реальному repo; порівняти self-hosted vs managed friction; перевірити willingness-to-pay саме за Cloud/support. |
| **Дні 61–90** | Посилити надійність executorів, onboarding, cost controls та документацію self-hosted; пріоритизувати Enterprise backlog (SSO, advanced audit, policy controls) за інтерв'ю. | 3 design-partner pilots; ≥1 paid managed/support signal; 1 публічний кейс за згодою клієнта. Go/no-go на підставі попиту й operational economics. |

**Guardrails пілотів:** дозволені репозиторії й ролі, секрети не йдуть у чат, контрольований executor, budget limits, audit trail, тести з repo, PR замість прямого push у main, merge/deploy тільки після людського рішення. Безпеки не можна «дофейкати» маркетингом.

## 7. Питання для стратегічного рішення

1. **Open-source scope:** підтверджуємо, що MCP/chat bridge розробляємо відкрито без Cloud-only gate?
2. **Managed promise:** що саме Bellows бере на себе в Cloud на першому етапі — runtime, maintenance, upgrades, monitoring, incident support — і які commitments можемо реально виконати?
3. **Enterprise package:** які вимоги з SSO, advanced audit, permissions, приватного розгортання та контрактної підтримки отримали від реальних покупців?
4. **Buyer:** хто платить за зняття operational burden — CTO, VP Engineering, Platform чи спільний product/engineering budget?
5. **Commercial packaging:** platform subscription + execution usage, окремий self-hosted support contract чи enterprise agreement? Який trigger робить це виправданим?

**Рекомендоване рішення:** PM-led brownfield — головний спосіб показати цінність **усього Bellows**. Community, включно із майбутнім MCP, залишається відкритим і самостійним. **Cloud монетизує надійні операції, інфраструктуру та підтримку; Enterprise — governance та compliance вимоги.** Хочуть підтримувати самі — чудово: open source не має штучних бар'єрів. Це важливий фактор довіри й дистрибуції.

---

*Оновлено після уточнення моделі монетизації: MCP планується також у Community; Cloud продає операції, інфраструктуру й підтримку; Enterprise — розширені організаційні функції. Збережено вихідну структуру GTM, PM-first brownfield use case, human review та 90-денний план. Усі числові цілі, ціни й roadmap — внутрішні гіпотези, не підтверджені ринкові дані.*