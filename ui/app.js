import { calculateQuality, ceilQuality } from "../core/quality.js";
import { toggleSelection } from "../core/selection.js";
import { drawHand, processSelected, replenishHand } from "../core/hand.js";
import { applyCraftToOrder, applyDiscardToOrder, calculateTargetQuality } from "../core/order.js";
import { advancePrototypeDay, applyDailyCycle, createOrderSession, getDailyCycleKey, getNextDailyResetTimestamp } from "../core/session.js";
import { createInitialInventory } from "../core/inventory.js";
import { createSeededRng, shuffle } from "../app/rng.js";

const DATA_URLS = {
  materials: "../data/materials.json",
  catalysts: "../data/catalysts.json",
  orders: "../data/orders.json",
  multipliers: "../data/multiplier-table.json",
  shopItems: "../data/shop-items.json",
  orderBalance: "../data/order-balance.json",
  initialLoadout: "../data/initial-loadout.json"
};

const RULES = Object.freeze({ handSize: 8, maxSelection: 5, minimumBoxSize: 24, maximumBoxSize: 99, maxCatalysts: 5 });
const DAILY_RESET_HOUR = 6;
const INITIAL_ORDER_SEED = 20260822;
const ATTRIBUTE = Object.freeze({
  fire: { name: "화", icon: "🔥" },
  water: { name: "수", icon: "💧" },
  light: { name: "명", icon: "✨" },
  dark: { name: "암", icon: "🌙" }
});
const GRADE = Object.freeze({
  common: "커먼", uncommon: "언커먼", rare: "레어", unique: "유니크", legendary: "레전더리"
});

const app = document.querySelector("#app");
const contentRemote = document.querySelector("#content-remote");
const data = await loadData();
let rng = createSeededRng(20260822);
let toastTimer;
let dailyResetTimer;
let brewTimer;
let tutorialFadeTimer;
let tutorialAdvanceTimer;
const TUTORIAL_CRAFT_SELECTION_COUNT = 2;
const ORDER_PLAY_TUTORIAL_STEPS = new Set([
  "craftSelect",
  "craftConfirm",
  "discardSelect",
  "discardConfirm",
  "catalyst",
  "freePlay"
]);

let state = createInitialState();
render();
scheduleDailyReset();
window.addEventListener("resize", positionTutorialGuide);

async function loadData() {
  const entries = await Promise.all(Object.entries(DATA_URLS).map(async ([key, url]) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} 데이터를 불러오지 못했습니다.`);
    return [key, await response.json()];
  }));
  return Object.fromEntries(entries);
}

function createInitialState() {
  const { storage, materialBox } = createInitialInventory(data.materials, data.initialLoadout);
  const defaults = {
    screen: "home",
    overlay: null,
    pendingOrderType: null,
    overlayTab: "materials",
    currencies: { alchemyCoin: 40, magicCrystal: 1200 },
    storage,
    materialBox,
    ownedCatalystIds: ["fire-amplifier", "water-amplifier"],
    equippedCatalystIds: ["fire-amplifier"],
    order: null,
    hand: [],
    deck: [],
    selectedIds: [],
    challengeStep: 1,
    challengeAttemptsRemaining: 5,
    highestChallengeStep: 0,
    dailyCompleted: false,
    dailyDay: 1,
    dailyCycleKey: getDailyCycleKey(Date.now(), DAILY_RESET_HOUR),
    nextOrderSeed: INITIAL_ORDER_SEED,
    activeOrder: null,
    pendingOrderSeed: null,
    brewing: false,
    result: null,
    shopResult: null,
    tutorialStep: "notice",
    toast: ""
  };
  return defaults;
}

function render() {
  app.innerHTML = state.screen === "home" ? renderHome() : renderCrafting();
  if (state.overlay) app.insertAdjacentHTML("beforeend", renderOverlay());
  if (state.result) app.insertAdjacentHTML("beforeend", renderResult());
  if (state.shopResult) app.insertAdjacentHTML("beforeend", renderMaterialPotResult());
  if (state.toast) app.insertAdjacentHTML("beforeend", `<div class="toast" role="status">${state.toast}</div>`);
  const tutorial = renderTutorial();
  if (tutorial) app.insertAdjacentHTML("beforeend", tutorial);
  applyTutorialHighlights();
  renderContentRemote();
  bindEvents();
  scheduleTutorialAutoAdvance();
}

function getTutorialGuide() {
  const guides = {
    modes: {
      title: "두 가지 의뢰",
      text: "일일 의뢰는 하루에 한 번 수행하는 기본 의뢰입니다. 도전 의뢰는 단계를 연속으로 돌파하며 최고 기록에 도전하는 모드입니다.",
      selectors: [".home-mode-menu"], placement: "left", autoNext: "complete"
    },
    daily: {
      title: "일일 의뢰 시작",
      text: "강조된 일일 의뢰 버튼을 눌러 첫 의뢰를 확인해 보세요.",
      selectors: [".home-mode-button.daily"], placement: "above"
    },
    acceptDaily: {
      title: "의뢰 정보 확인",
      text: "요구 품질과 보상을 확인한 뒤 수락 버튼을 눌러 조합대로 이동하세요.",
      selectors: [".order-accept"], placement: "right"
    },
    craftSelect: {
      title: "제조할 재료 선택",
      text: "손패에서는 재료를 최소 1개부터 최대 5개까지 선택할 수 있습니다. 선택한 재료에 따라 예상 품질이 즉시 계산되므로, 품질 변화를 확인하며 서로 다른 재료 2개를 선택해 보세요.",
      selectors: [".craft-hand-dock"], placement: "above"
    },
    craftConfirm: {
      title: "포션 제조와 품질",
      text: "위쪽 숫자는 누적 품질 / 요구 품질이며, + 숫자는 이번 제조로 얻을 품질입니다. 포션 제조를 눌러 품질을 누적하고 요구 품질에 도달하면 의뢰를 완수합니다.",
      selectors: [".quality-console", ".primary-control"], anchor: ".primary-control", placement: "above"
    },
    discardSelect: {
      title: "폐기할 재료 선택",
      text: "필요하지 않은 재료를 손패에서 하나 이상 선택하세요. 선택한 재료는 폐기 후 이번 의뢰에서 제외됩니다.",
      selectors: [".craft-hand-dock"], placement: "above"
    },
    discardConfirm: {
      title: "재료 폐기",
      text: "이제 재료 폐기 버튼을 누르세요. 폐기 횟수는 의뢰마다 제한되며, 처리한 수만큼 손패가 보충됩니다.",
      selectors: [".discard-control"], placement: "above"
    },
    catalyst: {
      title: "촉매 효과",
      text: "촉매는 특정 속성의 배수나 재료 등급 수치를 강화합니다. 장착된 촉매 아이콘에 마우스를 올리면 자세한 효과를 확인할 수 있습니다.",
      selectors: [".catalyst-hud-panel"], placement: "below", autoNext: "freePlay"
    },
    resultReturn: {
      title: "의뢰 완수",
      text: "의뢰를 완수했습니다. 공방으로 돌아가 상점과 창고 사용법을 이어서 확인하세요.",
      selectors: ["[data-action='return-home']"], placement: "above"
    },
    shopHome: {
      title: "재료 상점",
      text: "상점에서는 마력 결정으로 재료와 촉매를 구매할 수 있습니다. 상점 버튼을 눌러 보세요.",
      selectors: [".home-utilities [data-overlay='shop']"], placement: "above"
    },
    shopBuy: {
      title: "재료 항아리 구매",
      text: "재료 항아리를 구매하면 무작위 재료를 획득해 창고에 보관합니다. 강조된 재료 항아리를 구매하세요.",
      selectors: ["[data-buy='material-pot']"], placement: "right"
    },
    potResult: {
      title: "획득 결과 확인",
      text: "항아리에서 나온 재료의 속성과 등급을 확인한 뒤 확인 버튼을 누르세요.",
      selectors: [".material-result-modal"], placement: "below", compact: true
    },
    closeShop: {
      title: "메인 화면으로 복귀",
      text: "이제 상점을 닫고 메인 화면으로 돌아가 창고를 확인해 보겠습니다.",
      selectors: [".shop-footer [data-action='close-overlay']"], placement: "above"
    },
    storageHome: {
      title: "재료 창고",
      text: "창고에서는 보유 재료와 의뢰에 사용할 재료함 구성을 관리합니다. 창고 버튼을 누르세요.",
      selectors: [".home-utilities [data-overlay='storage']"], placement: "above"
    },
    storageAdd: {
      title: "창고 → 재료함",
      text: "왼쪽 창고 목록에서 활성화된 재료 아이콘을 누르면 해당 재료가 오른쪽 재료함으로 이동합니다. 방금 획득한 재료 하나를 옮겨 보세요.",
      selectors: [".storage-material-pane:first-child"], placement: "right"
    },
    storageRemove: {
      title: "재료함 → 창고",
      text: "오른쪽 재료함의 재료 아이콘을 누르면 다시 창고로 이동합니다. 재료 하나를 창고로 되돌려 보세요.",
      selectors: [".storage-material-pane:last-child"], placement: "left"
    },
    storageClose: {
      title: "창고 닫기",
      text: "양방향 이동을 확인했습니다. 닫기 버튼을 눌러 메인 화면으로 돌아가세요.",
      selectors: [".storage-titlebar [data-action='close-overlay']"], placement: "below"
    }
  };
  return guides[state.tutorialStep] ?? null;
}

function renderTutorial() {
  if (state.tutorialStep === "notice") {
    return `<div class="tutorial-modal-layer"><section class="tutorial-notice" role="dialog" aria-modal="true" aria-labelledby="tutorial-notice-title">
      <span class="tutorial-notice-icon">⚗</span>
      <h2 id="tutorial-notice-title">프로토타입 안내</h2>
      <p>본 UI는 이벤트 기능과 플레이 흐름을 테스트하기 위한 프로토타입입니다.</p>
      <p>사용된 이미지, 콘셉트, 명칭과 밸런스 수치는 추후 개발 과정에서 변경될 수 있습니다.</p>
      <button data-tutorial-next="daily">확인하고 튜토리얼 시작</button>
    </section></div>`;
  }
  if (state.tutorialStep === "complete") {
    return `<div class="tutorial-modal-layer"><section class="tutorial-notice tutorial-complete" role="dialog" aria-modal="true" aria-labelledby="tutorial-complete-title">
      <span class="tutorial-notice-icon">✓</span>
      <h2 id="tutorial-complete-title">튜토리얼 완료</h2>
      <p>연금술 공방의 기본 기능을 모두 확인했습니다.</p>
      <p>이제 원하는 의뢰와 상점, 창고 기능을 자유롭게 테스트해 주세요.</p>
      <button data-tutorial-next="done">튜토리얼 종료</button>
    </section></div>`;
  }
  const guide = getTutorialGuide();
  if (!guide) return "";
  return `<aside class="tutorial-guide ${guide.compact ? "compact" : ""}" role="status">
    <span class="tutorial-step-label">튜토리얼</span>
    <h2>${guide.title}</h2>
    <p>${guide.text}</p>
    ${guide.action
      ? `<button data-tutorial-next="${guide.next}">${guide.action}</button>`
      : `<small>${guide.autoNext ? "잠시 후 자동으로 다음 안내가 이어집니다." : "강조된 UI를 조작해 진행하세요."}</small>`}
  </aside>`;
}

function applyTutorialHighlights() {
  const guide = getTutorialGuide();
  if (!guide) return;
  guide.selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((element) => element.classList.add("tutorial-highlight"));
  });
  window.requestAnimationFrame(positionTutorialGuide);
}

function getAppViewportSpace() {
  const appRect = app.getBoundingClientRect();
  const rotated = document.documentElement.dataset.rotatePortrait === "true";
  const scale = rotated
    ? appRect.height / app.clientWidth || 1
    : appRect.width / app.clientWidth || 1;

  return { appRect, rotated, scale };
}

function viewportRectToAppRect(rect, space) {
  if (space.rotated) {
    const left = (rect.top - space.appRect.top) / space.scale;
    const top = (space.appRect.right - rect.right) / space.scale;
    const width = rect.height / space.scale;
    const height = rect.width / space.scale;
    return { left, top, right: left + width, bottom: top + height, width, height };
  }

  const left = (rect.left - space.appRect.left) / space.scale;
  const top = (rect.top - space.appRect.top) / space.scale;
  const width = rect.width / space.scale;
  const height = rect.height / space.scale;
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function viewportPointToAppPoint(clientX, clientY, space) {
  if (space.rotated) {
    return {
      x: (clientY - space.appRect.top) / space.scale,
      y: (space.appRect.right - clientX) / space.scale
    };
  }
  return {
    x: (clientX - space.appRect.left) / space.scale,
    y: (clientY - space.appRect.top) / space.scale
  };
}

function positionTutorialGuide() {
  const config = getTutorialGuide();
  const panel = app.querySelector(".tutorial-guide");
  const target = config ? app.querySelector(config.anchor ?? config.selectors[0]) : null;
  if (!config || !panel || !target) return;

  const space = getAppViewportSpace();
  const targetRect = viewportRectToAppRect(target.getBoundingClientRect(), space);
  const panelRect = viewportRectToAppRect(panel.getBoundingClientRect(), space);
  const targetLeft = targetRect.left;
  const targetTop = targetRect.top;
  const targetRight = targetRect.right;
  const targetBottom = targetRect.bottom;
  const targetWidth = targetRect.width;
  const targetHeight = targetRect.height;
  const panelWidth = panelRect.width;
  const panelHeight = panelRect.height;
  const gap = 14;
  const margin = 10;
  const targetCenterX = targetLeft + targetWidth / 2;
  const targetCenterY = targetTop + targetHeight / 2;
  let left;
  let top;

  if (config.placement === "above") {
    left = targetCenterX - panelWidth / 2;
    top = targetTop - panelHeight - gap;
  } else if (config.placement === "below") {
    left = targetCenterX - panelWidth / 2;
    top = targetBottom + gap;
  } else if (config.placement === "left") {
    left = targetLeft - panelWidth - gap;
    top = targetCenterY - panelHeight / 2;
  } else {
    left = targetRight + gap;
    top = targetCenterY - panelHeight / 2;
  }

  left = Math.max(margin, Math.min(left, app.clientWidth - panelWidth - margin));
  top = Math.max(margin, Math.min(top, app.clientHeight - panelHeight - margin));
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.dataset.arrow = config.placement;
  panel.style.setProperty("--tutorial-arrow-x", `${Math.max(16, Math.min(targetCenterX - left, panelWidth - 16))}px`);
  panel.style.setProperty("--tutorial-arrow-y", `${Math.max(16, Math.min(targetCenterY - top, panelHeight - 16))}px`);
}

function scheduleTutorialAutoAdvance() {
  window.clearTimeout(tutorialFadeTimer);
  window.clearTimeout(tutorialAdvanceTimer);
  const currentStep = state.tutorialStep;
  const config = getTutorialGuide();
  if (!config?.autoNext) return;

  tutorialFadeTimer = window.setTimeout(() => {
    if (state.tutorialStep !== currentStep) return;
    app.querySelector(".tutorial-guide")?.classList.add("dissolving");
  }, 1500);
  tutorialAdvanceTimer = window.setTimeout(() => {
    if (state.tutorialStep === currentStep) setState({ tutorialStep: config.autoNext });
  }, 1950);
}

function renderContentRemote() {
  contentRemote.innerHTML = `<h2>콘텐츠 리모컨</h2>
    <p>프로토타입 <strong>${state.dailyDay}일차</strong></p>
    <button data-remote-action="next-day"><span>📅</span>날짜 넘기기<small>다음 일일 의뢰 갱신</small></button>
    <button data-remote-action="gain-crystal"><span>◆</span>마력 결정 +1,000<small>상점 테스트 재화 지급</small></button>`;
}

function renderTopbar({ inOrder = false } = {}) {
  return `<header class="topbar">
    <img class="brand" src="./Resource/EventText.png" alt="아라드 연금술 공방" />
    <div class="currencies">
      <span class="currency">연금 주화 <b>${state.currencies.alchemyCoin}</b></span>
      <span class="currency">마력 결정 <b>${state.currencies.magicCrystal}</b></span>
    </div>
    ${inOrder ? `<button class="icon-button" data-action="exit-order">나가기</button>` : `
      <button class="icon-button" data-overlay="storage">창고</button>
      <button class="icon-button" data-overlay="shop">재료 상점</button>`}
  </header>`;
}

function renderHome() {
  const boxSize = getBoxSize();
  const canStart = boxSize >= RULES.minimumBoxSize;
  const dailyInProgress = state.activeOrder?.type === "daily";
  const challengeInProgress = state.activeOrder?.type === "challenge";
  return `<main class="shell home">
    <section class="home-stage">
      <div class="home-currencies" aria-label="보유 재화">
        <span>연금 주화 <b>${state.currencies.alchemyCoin}</b></span>
        <span>마력 결정 <b>${state.currencies.magicCrystal}</b></span>
      </div>
      <header class="home-hero">
        <img src="./Resource/EventText.png" alt="아라드 연금술 공방" />
      </header>
      <nav class="home-mode-menu" aria-label="의뢰 선택">
        <button class="home-mode-button daily" data-start="daily" ${(!canStart && !dailyInProgress) || (state.dailyCompleted && !dailyInProgress) ? "disabled" : ""}>
          <span class="mode-symbol">☀</span><span><strong>일일 의뢰</strong><small>${dailyInProgress ? "진행 중 · 처음부터 이어하기" : state.dailyCompleted ? "오늘의 의뢰 완료" : "하루 1회 · 연금 주화 보상"}</small></span>
        </button>
        <button class="home-mode-button challenge" data-start="challenge" ${(!canStart && !challengeInProgress) || (state.challengeAttemptsRemaining === 0 && !challengeInProgress) ? "disabled" : ""}>
          <span class="mode-symbol">◆</span><span><strong>도전 의뢰</strong><small>${challengeInProgress ? `${state.activeOrder.step}단계 진행 중 · 처음부터 이어하기` : `${state.challengeStep}단계 · 남은 도전 ${state.challengeAttemptsRemaining}/5 · 최고 ${state.highestChallengeStep}단계`}</small></span>
        </button>
      </nav>
      <nav class="home-utilities" aria-label="공방 메뉴">
        <button data-overlay="shop"><span>🏺</span><strong>상점</strong></button>
        <button data-overlay="storage" ${state.activeOrder ? "disabled" : ""}><span>📦</span><strong>창고</strong></button>
        <button data-action="missions"><span>📜</span><strong>미션</strong></button>
      </nav>
      <p class="home-loadout">재료함 <b>${boxSize}/99</b><i></i>장착 촉매 <b>${state.equippedCatalystIds.length}/5</b></p>
    </section>
  </main>`;
}

function renderCrafting() {
  const preview = getPreviewQuality();
  const order = state.order;
  const orderProgressLabel = order.type === "daily" ? `${order.step} 일차` : `${order.step} 단계`;
  return `<main class="shell crafting">
    <button class="craft-exit" data-action="exit-order" aria-label="의뢰 나가기" ${state.brewing ? "disabled" : ""}>×</button>
    <section class="craft-stage">
      <header class="craft-hud">
        <aside class="current-order-card">
          <span>현재 의뢰</span>
          <strong>${orderProgressLabel}</strong>
        </aside>
        <div class="quality-console" aria-label="품질 현황">
          <div class="quality-ratio"><span>${formatQuality(order.accumulatedQuality)}</span><i>/</i><strong>${formatQuality(order.targetQuality)}</strong></div>
          <div class="quality-preview">+ ${formatQuality(preview)}</div>
          <small>누적 품질 / 요구 품질</small>
        </div>
        <aside class="catalyst-hud-panel" aria-label="장착 촉매">
          <strong>촉매</strong>
          <div>${renderCatalystSlots()}</div>
          <small>장착 ${getEquippedCatalysts().length} / 5</small>
        </aside>
      </header>
      <div class="craft-cauldron-zone">
        <div class="brew-orb ${state.brewing ? "brewing" : ""}"></div>
      </div>
      <section class="craft-hand-dock">
        <div class="craft-hand">${renderHand()}</div>
      </section>
      <footer class="craft-control-dock">
        <div class="control-group primary-control">
          <button class="craft-command" data-action="craft" ${state.selectedIds.length === 0 || state.brewing ? "disabled" : ""}><span>⚗</span>포션 제조</button>
          <small>[ ${order.craftsRemaining} / ${order.craftCount} ]</small>
        </div>
        <div class="sort-control">
          <strong>재료 정렬</strong>
          <div><button data-sort="attribute">속성</button><button data-sort="grade">등급</button></div>
        </div>
        <div class="control-group discard-control">
          <button class="discard-command" data-action="discard" ${state.selectedIds.length === 0 || order.discardsRemaining === 0 || state.brewing ? "disabled" : ""}><span>▥</span>재료 폐기</button>
          <small>[ ${order.discardsRemaining} / ${order.discardCount} ]</small>
        </div>
        <div class="material-box-status"><span>📦</span><strong>남은 재료 : ${state.deck.length}</strong></div>
      </footer>
    </section>
    <div class="catalyst-tooltip" role="tooltip" hidden>
      <span class="catalyst-tooltip-icon"></span>
      <div><strong class="catalyst-tooltip-name"></strong><small>촉매 효과</small><p class="catalyst-tooltip-effect"></p></div>
    </div>
  </main>`;
}

function renderCatalystSlots() {
  const equipped = getEquippedCatalysts();
  return Array.from({ length: RULES.maxCatalysts }, (_, index) => {
    const catalyst = equipped[index];
    return catalyst
      ? `<i class="filled" data-catalyst-tooltip-id="${catalyst.ID}" aria-label="${catalyst.Name}">${ATTRIBUTE[catalyst.Attribute].icon}</i>`
      : `<i aria-label="빈 촉매 슬롯"></i>`;
  }).join("");
}

function renderPips(label, remaining, total) {
  const pips = Array.from({ length: total }, (_, index) => `<span class="${index < remaining ? "on" : ""}">◆</span>`).join("");
  return `<div class="attempt-row"><span>${label}</span><span class="pips">${pips}</span></div>`;
}

function renderHand() {
  return Array.from({ length: RULES.handSize }, (_, index) => {
    const material = state.hand[index];
    if (!material) return `<div class="empty-slot">비어 있음</div>`;
    const selected = state.selectedIds.includes(material.instanceId);
    return `<button class="material-card ${selected ? "selected" : ""}" data-material-id="${material.instanceId}" data-grade="${material.Grade}" aria-pressed="${selected}">
      <span class="grade">${GRADE[material.Grade]}</span>
      <span class="element">${ATTRIBUTE[material.Attribute].icon}</span>
      <strong>${material.Name}</strong>
    </button>`;
  }).join("");
}

function renderCatalystChip(catalyst) {
  return `<div class="catalyst-chip"><span class="element">${ATTRIBUTE[catalyst.Attribute].icon}</span><span><b>${catalyst.Name}</b><br />${formatCatalystEffect(catalyst)}</span></div>`;
}

function renderOverlay() {
  if (state.overlay === "storage") return renderStorage();
  if (state.overlay === "orderInfo") return renderOrderInfo();
  if (state.overlay === "resumePrompt") return renderResumePrompt();
  return renderShop();
}

function renderResumePrompt() {
  const activeLabel = state.activeOrder?.type === "daily"
    ? "일일 의뢰"
    : `도전 의뢰 ${state.activeOrder?.step ?? ""}단계`;
  return `<div class="overlay"><section class="modal result-modal" role="dialog" aria-modal="true" aria-labelledby="resume-title">
    <div class="result-icon">⚗</div>
    <h2 id="resume-title">진행 중인 의뢰</h2>
    <p>${activeLabel}가 진행 중입니다.<br />진행 중이던 의뢰를 포기하시겠습니까?</p>
    <p class="resume-note">이어하기를 선택하면 저장된 재료함·촉매 구성과 같은 손패 순서로 의뢰 시작 지점부터 다시 진행합니다.</p>
    <div class="result-actions">
      <button class="action craft" data-action="resume-order">이어하기</button>
      <button class="action discard" data-action="abandon-order">포기하기</button>
      <button class="action neutral" data-action="close-resume-prompt">취소</button>
    </div>
  </section></div>`;
}

function renderOrderInfo() {
  const orderData = getOrderData(state.pendingOrderType);
  if (!orderData) return "";
  const targetQuality = calculateTargetQuality(orderData.Type, orderData.Step, data.orderBalance);
  const stageLabel = orderData.Type === "daily" ? `${orderData.Step}일차` : `${orderData.Step}단계`;
  const reward = orderData.RewardId === "alchemy-coin-20"
    ? { icon: "◆", name: "연금 주화", amount: "20개" }
    : { icon: "♛", name: "도전 기록", amount: "최고 단계 갱신" };
  const rewardIcons = Array.from({ length: 6 }, () => `<i aria-hidden="true"><img src="./Resource/reward-crystal.svg" alt="" /></i>`).join("");

  return `<div class="overlay order-info-overlay">
    <section class="order-info-popup" role="dialog" aria-modal="true" aria-labelledby="order-info-title">
      <header class="order-info-head"><h2 id="order-info-title">현재 의뢰</h2></header>
      <p class="order-info-stage">의뢰 단계 : <strong>${stageLabel}</strong></p>
      <div class="order-info-quality"><span>요구 품질</span><strong>${formatQuality(targetQuality)}</strong></div>
      <section class="order-info-reward" aria-label="의뢰 보상">
        <h3>보상</h3>
        <div class="order-reward-list" aria-label="${reward.name} ${reward.amount}">${rewardIcons}</div>
      </section>
      <button class="order-accept" data-confirm-order="${orderData.Type}">수락</button>
    </section>
  </div>`;
}

function modalFrame(title, content) {
  return `<div class="overlay"><section class="modal" role="dialog" aria-modal="true" aria-label="${title}">
    <header class="modal-head"><h2>${title}</h2><button data-action="close-overlay" aria-label="닫기">×</button></header>
    ${content}
  </section></div>`;
}

function renderStorage() {
  const tabs = `<div class="tabs"><button class="tab ${state.overlayTab === "materials" ? "active" : ""}" data-tab="materials">재료 창고</button><button class="tab ${state.overlayTab === "catalysts" ? "active" : ""}" data-tab="catalysts">촉매</button></div>`;
  const body = state.overlayTab === "materials" ? renderMaterialStorage() : renderCatalystStorage();
  return `<div class="overlay storage-overlay"><section class="storage-modal" role="dialog" aria-modal="true" aria-labelledby="storage-title">
    <header class="storage-titlebar"><h2 id="storage-title">창고</h2><button data-action="close-overlay" aria-label="닫기">×</button></header>
    ${tabs}
    <div class="storage-content">${body}</div>
  </section></div>`;
}

function renderMaterialStorage() {
  return `<div class="storage-material-layout">
    <section class="storage-material-pane">
      <h3>창고 목록</h3>
      <div class="storage-attribute-list">${Object.keys(ATTRIBUTE).map((attribute) => renderStorageAttributeRow(attribute, "add")).join("")}</div>
    </section>
    <div class="storage-transfer-arrows" aria-hidden="true"><span>▶</span><span>◀</span></div>
    <section class="storage-material-pane">
      <h3>재료함 <small>${getBoxSize()} / ${RULES.maximumBoxSize}</small></h3>
      <div class="storage-attribute-list">${Object.keys(ATTRIBUTE).map((attribute) => renderStorageAttributeRow(attribute, "remove")).join("")}</div>
    </section>
  </div>`;
}

function renderStorageAttributeRow(attribute, direction) {
  const materials = data.materials.filter((material) => material.Attribute === attribute);
  return `<div class="storage-attribute-row">
    <span class="storage-attribute-icon" title="${ATTRIBUTE[attribute].name} 속성">${ATTRIBUTE[attribute].icon}</span>
    <div class="storage-material-icons">${materials.map((material) => renderStorageMaterialIcon(material, direction)).join("")}</div>
  </div>`;
}

function renderStorageMaterialIcon(material, direction) {
  const inBox = state.materialBox[material.ID] ?? 0;
  const available = state.storage[material.ID] - inBox;
  const count = direction === "add" ? available : inBox;
  const disabled = count === 0 || (direction === "add" && getBoxSize() >= RULES.maximumBoxSize);
  const actionText = direction === "add" ? "재료함에 추가" : "창고로 이동";
  return `<button class="storage-material-icon" data-box-action="${direction}" data-template-id="${material.ID}" data-grade="${material.Grade}" data-attribute="${material.Attribute}" aria-label="${material.Name} ${count}개, ${actionText}" title="${GRADE[material.Grade]} · ${material.Name} · ${count}개" ${disabled ? "disabled" : ""}>
    <span class="storage-material-art"><b aria-hidden="true"></b><em>${ATTRIBUTE[material.Attribute].icon}</em></span>
    <strong>${count}</strong>
  </button>`;
}

function renderInventoryItem(material, direction) {
  const inBox = state.materialBox[material.ID] ?? 0;
  const available = state.storage[material.ID] - inBox;
  const count = direction === "add" ? available : inBox;
  const disabled = count === 0 || (direction === "add" && getBoxSize() >= RULES.maximumBoxSize);
  return `<button class="inventory-item" data-box-action="${direction}" data-template-id="${material.ID}" data-grade="${material.Grade}" ${disabled ? "disabled" : ""}>
    <span class="element">${ATTRIBUTE[material.Attribute].icon}</span><b>${GRADE[material.Grade]}</b>${material.Name}
    <span class="inventory-count"><span>${direction === "add" ? "남음" : "편성"}</span><strong>${count}</strong></span>
  </button>`;
}

function renderCatalystStorage() {
  const owned = data.catalysts.filter((catalyst) => state.ownedCatalystIds.includes(catalyst.ID));
  return `<p class="hint">촉매는 최대 5개까지 장착할 수 있습니다. 동일 촉매는 중복 장착할 수 없으며 의뢰 진행 중에는 구성을 바꿀 수 없습니다.</p>
    <div class="box-summary"><span>보유 촉매 ${owned.length}</span><strong>장착 ${state.equippedCatalystIds.length}/5</strong></div>
    <div class="catalyst-grid">${owned.map((catalyst) => {
      const equipped = state.equippedCatalystIds.includes(catalyst.ID);
      return `<article class="catalyst-card ${equipped ? "equipped" : ""}"><span class="element">${ATTRIBUTE[catalyst.Attribute].icon}</span><h3>${catalyst.Name}</h3><p>${formatCatalystEffect(catalyst)}</p><button data-catalyst-toggle="${catalyst.ID}">${equipped ? "장착 해제" : "장착"}</button></article>`;
    }).join("")}</div>`;
}

function renderShop() {
  const pot = data.shopItems.find((item) => item.ItemType === "materialPot");
  const box = data.shopItems.find((item) => item.ItemType === "catalystBox");
  const potDisabled = state.currencies.magicCrystal < pot.Price;
  const catalystProducts = data.catalysts.map((catalyst) => {
    const owned = state.ownedCatalystIds.includes(catalyst.ID);
    const disabled = owned || state.currencies.magicCrystal < box.Price;
    return `<button class="shop-product catalyst-product" data-buy-catalyst="${catalyst.ID}" ${disabled ? "disabled" : ""}>
      <span class="shop-product-icon catalyst-box-icon"><b>▣</b><em>${ATTRIBUTE[catalyst.Attribute].icon}</em></span>
      <span class="shop-product-copy"><strong>${ATTRIBUTE[catalyst.Attribute].name} 속성 촉매 상자</strong><small>계정당 ${owned ? 1 : 0}/1개 · ${formatCatalystEffect(catalyst)}</small></span>
      <span class="shop-product-price">${owned ? "보유 완료" : `${box.Price.toLocaleString("ko-KR")} <i>◆</i>`}</span>
    </button>`;
  }).join("");

  return `<div class="overlay shop-overlay"><section class="shop-modal" role="dialog" aria-modal="true" aria-labelledby="shop-title">
    <h2 id="shop-title">마력 결정 상점</h2>
    <div class="shop-product-grid">
      <button class="shop-product material-pot-product" data-buy="material-pot" ${potDisabled ? "disabled" : ""}>
        <span class="shop-product-icon">🏺</span>
        <span class="shop-product-copy"><strong>${pot.Name}</strong><small>개봉 시 무작위 재료 ${pot.DropTable.Count}개 획득</small></span>
        <span class="shop-product-price">${pot.Price.toLocaleString("ko-KR")} <i>◆</i></span>
      </button>
      ${catalystProducts}
    </div>
    <footer class="shop-footer">
      <p>보유 마력 결정 <strong>${state.currencies.magicCrystal.toLocaleString("ko-KR")}</strong> <i>◆</i></p>
      <button data-action="close-overlay">닫기</button>
    </footer>
  </section></div>`;
}

function renderMaterialPotResult() {
  return `<div class="overlay material-result-overlay"><section class="material-result-modal" role="dialog" aria-modal="true" aria-labelledby="material-result-title">
    <h2 id="material-result-title">항아리 개봉 결과</h2>
    <p>획득한 재료가 창고에 보관되었습니다.</p>
    <div class="material-result-grid">${state.shopResult.map((material) => `<article class="material-result-card" data-grade="${material.Grade}">
      <span class="grade">${GRADE[material.Grade]}</span>
      <span class="element">${ATTRIBUTE[material.Attribute].icon}</span>
      <strong>${material.Name}</strong>
      <small>${ATTRIBUTE[material.Attribute].name} 속성 · 품질 ${material.QualityValue}</small>
    </article>`).join("")}</div>
    <button class="material-result-confirm" data-action="close-shop-result">확인</button>
  </section></div>`;
}

function renderResult() {
  const success = state.result === "success";
  const challenge = state.order.type === "challenge";
  return `<div class="overlay"><section class="modal result-modal" role="dialog" aria-modal="true">
    <div class="result-icon">${success ? "🏆" : "⚗"}</div><h2>${success ? "의뢰 완수!" : "의뢰 실패"}</h2>
    <p>${success ? `누적 품질 ${formatQuality(state.order.accumulatedQuality)}로 요구치를 달성했습니다.` : `제조 횟수를 모두 사용했지만 품질이 부족합니다.`}</p>
    <div class="result-actions">
      ${success && challenge && data.orders.some((order) => order.Type === "challenge" && order.Step === state.order.step + 1) ? `<button class="action craft" data-action="next-challenge">다음 의뢰</button>` : ""}
      <button class="action discard" data-action="return-home">공방으로 돌아가기</button>
    </div>
  </section></div>`;
}

function bindEvents() {
  document.querySelectorAll("[data-overlay]").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.overlay === "storage" && state.activeOrder) return showToast("진행 중인 의뢰를 마치거나 포기한 뒤 구성을 변경할 수 있습니다.");
    const tutorialStep = state.tutorialStep === "shopHome" && button.dataset.overlay === "shop"
      ? "shopBuy"
      : state.tutorialStep === "storageHome" && button.dataset.overlay === "storage"
        ? "storageAdd"
        : state.tutorialStep;
    setState({ overlay: button.dataset.overlay, overlayTab: "materials", tutorialStep });
  }));
  document.querySelector("[data-action='close-overlay']")?.addEventListener("click", closeOverlay);
  document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => setState({ overlayTab: button.dataset.tab })));
  document.querySelectorAll("[data-start]").forEach((button) => button.addEventListener("click", () => requestOrderStart(button.dataset.start)));
  document.querySelector("[data-confirm-order]")?.addEventListener("click", (event) => startOrder(event.currentTarget.dataset.confirmOrder));
  document.querySelectorAll("[data-material-id]").forEach((button) => button.addEventListener("click", () => selectMaterial(button.dataset.materialId)));
  document.querySelector("[data-action='craft']")?.addEventListener("click", craftPotion);
  document.querySelector("[data-action='discard']")?.addEventListener("click", discardMaterials);
  document.querySelector("[data-action='exit-order']")?.addEventListener("click", finishRun);
  document.querySelectorAll("[data-box-action]").forEach((button) => button.addEventListener("click", () => moveMaterial(button.dataset.templateId, button.dataset.boxAction)));
  document.querySelectorAll("[data-catalyst-toggle]").forEach((button) => button.addEventListener("click", () => toggleCatalyst(button.dataset.catalystToggle)));
  document.querySelector("[data-buy='material-pot']")?.addEventListener("click", buyMaterialPot);
  document.querySelectorAll("[data-buy-catalyst]").forEach((button) => button.addEventListener("click", () => buyCatalyst(button.dataset.buyCatalyst)));
  document.querySelector("[data-action='close-shop-result']")?.addEventListener("click", closeShopResult);
  document.querySelector("[data-action='return-home']")?.addEventListener("click", finishRun);
  document.querySelector("[data-action='next-challenge']")?.addEventListener("click", startNextChallenge);
  document.querySelector("[data-action='resume-order']")?.addEventListener("click", resumeActiveOrder);
  document.querySelector("[data-action='abandon-order']")?.addEventListener("click", abandonActiveOrder);
  document.querySelector("[data-action='close-resume-prompt']")?.addEventListener("click", () => setState({ overlay: null, pendingOrderType: null }));
  document.querySelector("[data-action='missions']")?.addEventListener("click", () => showToast("미션 메뉴는 추후 프로토타입에서 제공됩니다."));
  document.querySelectorAll("[data-sort]").forEach((button) => button.addEventListener("click", () => sortHand(button.dataset.sort)));
  document.querySelectorAll("[data-tutorial-next]").forEach((button) => button.addEventListener("click", () => setState({ tutorialStep: button.dataset.tutorialNext })));
  contentRemote.querySelector("[data-remote-action='next-day']")?.addEventListener("click", advanceDayFromRemote);
  contentRemote.querySelector("[data-remote-action='gain-crystal']")?.addEventListener("click", gainMagicCrystalsFromRemote);
  bindCatalystTooltips();
}

function bindCatalystTooltips() {
  const tooltip = document.querySelector(".catalyst-tooltip");
  if (!tooltip) return;

  const positionTooltip = (event) => {
    const space = getAppViewportSpace();
    const gap = 12;
    const margin = 8;
    const cursor = viewportPointToAppPoint(event.clientX, event.clientY, space);
    const left = Math.max(margin, Math.min(cursor.x - tooltip.offsetWidth - gap, app.clientWidth - tooltip.offsetWidth - margin));
    const top = Math.max(margin, Math.min(cursor.y - tooltip.offsetHeight - gap, app.clientHeight - tooltip.offsetHeight - margin));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  document.querySelectorAll("[data-catalyst-tooltip-id]").forEach((slot) => {
    const showTooltip = (event) => {
      const catalyst = data.catalysts.find((item) => item.ID === slot.dataset.catalystTooltipId);
      if (!catalyst) return;
      tooltip.querySelector(".catalyst-tooltip-icon").textContent = ATTRIBUTE[catalyst.Attribute].icon;
      tooltip.querySelector(".catalyst-tooltip-name").textContent = catalyst.Name;
      tooltip.querySelector(".catalyst-tooltip-effect").textContent = formatCatalystEffect(catalyst);
      tooltip.hidden = false;
      positionTooltip(event);
    };
    slot.addEventListener("pointerenter", showTooltip);
    slot.addEventListener("pointermove", positionTooltip);
    slot.addEventListener("pointerleave", () => { tooltip.hidden = true; });
  });
}

function getOrderData(type) {
  if (type === "daily") {
    const dailyOrder = data.orders.find((order) => order.Type === "daily");
    return dailyOrder ? { ...dailyOrder, Step: state.dailyDay } : null;
  }
  if (type === "challenge") return data.orders.find((order) => order.Type === "challenge" && order.Step === state.challengeStep);
  return null;
}

function getOrderDataAtStep(type, step) {
  if (type === "daily") {
    const dailyOrder = data.orders.find((order) => order.Type === "daily");
    return dailyOrder ? { ...dailyOrder, Step: step } : null;
  }
  return data.orders.find((order) => order.Type === type && order.Step === step) ?? null;
}

function advanceDayFromRemote() {
  window.clearTimeout(brewTimer);
  const advanced = advancePrototypeDay(state);
  state = advanced.interruptedDailyOrder
    ? {
        ...advanced.progress,
        screen: "home",
        overlay: null,
        pendingOrderType: null,
        pendingOrderSeed: null,
        order: null,
        hand: [],
        deck: [],
        selectedIds: [],
        brewing: false,
        result: null
      }
    : advanced.progress;
  showToast(`${state.dailyDay}일차 일일 의뢰가 열렸습니다.`);
}

function gainMagicCrystalsFromRemote() {
  setState({ currencies: { ...state.currencies, magicCrystal: state.currencies.magicCrystal + 1000 } });
  showToast("마력 결정 1,000개를 획득했습니다.");
}

function requestOrderStart(type) {
  if (state.activeOrder) {
    return setState({ overlay: "resumePrompt", pendingOrderType: type });
  }
  if (state.tutorialStep === "daily" && type === "daily") {
    state = { ...state, tutorialStep: "acceptDaily" };
  }
  openOrderInfo(type);
}

function openOrderInfo(type) {
  const orderData = getOrderData(type);
  if (!orderData) return showToast("준비된 마지막 도전 단계입니다.");
  const pendingOrderSeed = state.nextOrderSeed;
  const prepared = prepareOrder(orderData, pendingOrderSeed);
  setState({
    screen: "craft",
    overlay: "orderInfo",
    pendingOrderType: type,
    pendingOrderSeed,
    hand: prepared.hand,
    deck: prepared.deck,
    selectedIds: [],
    result: null,
    order: prepared.order
  });
}

function closeOverlay() {
  if (state.overlay !== "orderInfo") {
    const tutorialStep = state.tutorialStep === "closeShop"
      ? "storageHome"
      : state.tutorialStep === "storageClose"
        ? "modes"
        : state.tutorialStep;
    return setState({ overlay: null, pendingOrderType: null, tutorialStep });
  }
  setState({ screen: "home", overlay: null, pendingOrderType: null, pendingOrderSeed: null, order: null, hand: [], deck: [], selectedIds: [] });
}

function prepareOrder(orderData, seed, materialBox = state.materialBox) {
  const instances = createDeckFromBox(materialBox, seed);
  const drawn = drawHand(shuffle(instances, createSeededRng(seed)), RULES.handSize);
  return {
    hand: drawn.hand,
    deck: drawn.deck,
    order: {
      id: orderData.ID, name: orderData.Name, type: orderData.Type, step: orderData.Step,
      targetQuality: calculateTargetQuality(orderData.Type, orderData.Step, data.orderBalance), accumulatedQuality: 0,
      craftCount: orderData.CraftCount, craftsRemaining: orderData.CraftCount,
      discardCount: orderData.DiscardCount, discardsRemaining: orderData.DiscardCount,
      status: "playing"
    }
  };
}

function setState(patch) {
  state = { ...state, ...patch };
  render();
}

function startOrder(type) {
  const orderData = getOrderData(type);
  if (!orderData) return showToast("준비된 마지막 도전 단계입니다.");
  const seed = state.pendingOrderType === type && state.pendingOrderSeed !== null
    ? state.pendingOrderSeed
    : state.nextOrderSeed;
  const prepared = state.pendingOrderType === type && state.order?.id === orderData.ID
    ? { hand: state.hand, deck: state.deck, order: state.order }
    : prepareOrder(orderData, seed);
  const activeOrder = createOrderSession({
    type,
    step: orderData.Step,
    seed,
    materialBox: state.materialBox,
    equippedCatalystIds: state.equippedCatalystIds
  });
  const challengeAttemptsRemaining = type === "challenge" && state.challengeStep === 1
    ? Math.max(0, state.challengeAttemptsRemaining - 1)
    : state.challengeAttemptsRemaining;
  setState({
    screen: "craft",
    overlay: null,
    pendingOrderType: null,
    pendingOrderSeed: null,
    hand: prepared.hand,
    deck: prepared.deck,
    selectedIds: [],
    result: null,
    challengeAttemptsRemaining,
    nextOrderSeed: (seed + 1) >>> 0,
    activeOrder,
    order: prepared.order,
    tutorialStep: state.tutorialStep === "acceptDaily" && type === "daily" ? "craftSelect" : state.tutorialStep
  });
}

function createDeckFromBox(materialBox, seed) {
  return Object.entries(materialBox).flatMap(([templateId, count]) => {
    const template = data.materials.find((material) => material.ID === templateId);
    return Array.from({ length: count }, (_, index) => ({ ...template, instanceId: `${seed}-${templateId}-${index}` }));
  });
}

function resumeActiveOrder() {
  const session = state.activeOrder;
  if (!session) return setState({ overlay: null, pendingOrderType: null });
  const orderData = getOrderDataAtStep(session.type, session.step);
  if (!orderData) return showToast("저장된 의뢰 데이터를 찾을 수 없습니다.");
  const prepared = prepareOrder(orderData, session.seed, session.materialBox);
  setState({
    screen: "craft",
    overlay: null,
    pendingOrderType: null,
    pendingOrderSeed: null,
    materialBox: { ...session.materialBox },
    equippedCatalystIds: [...session.equippedCatalystIds],
    hand: prepared.hand,
    deck: prepared.deck,
    selectedIds: [],
    result: null,
    order: prepared.order
  });
}

function abandonActiveOrder() {
  const abandoned = state.activeOrder;
  if (!abandoned) return setState({ overlay: null, pendingOrderType: null });
  const requestedType = state.pendingOrderType;
  const patch = abandoned.type === "daily"
    ? { dailyCompleted: true }
    : { highestChallengeStep: Math.max(state.highestChallengeStep, abandoned.step), challengeStep: 1 };
  state = {
    ...state,
    ...patch,
    activeOrder: null,
    screen: "home",
    overlay: null,
    pendingOrderType: null,
    pendingOrderSeed: null,
    order: null,
    hand: [],
    deck: [],
    selectedIds: [],
    result: null
  };
  render();
  if (requestedType === "daily" && state.dailyCompleted) return showToast("진행 중이던 일일 의뢰를 포기해 오늘의 도전이 종료되었습니다.");
  if (requestedType === "challenge" && state.challengeAttemptsRemaining === 0) return showToast("남은 도전 횟수가 없습니다.");
  if (requestedType) openOrderInfo(requestedType);
}

function selectMaterial(instanceId) {
  const next = toggleSelection(state.selectedIds, instanceId, RULES.maxSelection);
  if (next === state.selectedIds && !state.selectedIds.includes(instanceId)) showToast("재료는 최대 5개까지 선택할 수 있습니다.");
  else {
    const tutorialStep = state.tutorialStep === "craftSelect" && next.length >= TUTORIAL_CRAFT_SELECTION_COUNT
      ? "craftConfirm"
      : state.tutorialStep === "discardSelect" && next.length > 0
        ? "discardConfirm"
        : state.tutorialStep === "discardConfirm" && next.length === 0
          ? "discardSelect"
          : state.tutorialStep;
    setState({ selectedIds: next, tutorialStep });
  }
}

function sortHand(mode) {
  const attributeOrder = { fire: 0, water: 1, light: 2, dark: 3 };
  const hand = [...state.hand].sort((left, right) => mode === "grade"
    ? right.QualityValue - left.QualityValue || attributeOrder[left.Attribute] - attributeOrder[right.Attribute]
    : attributeOrder[left.Attribute] - attributeOrder[right.Attribute] || right.QualityValue - left.QualityValue);
  setState({ hand });
}

function getPreviewQuality() {
  const selected = state.hand.filter((material) => state.selectedIds.includes(material.instanceId));
  return ceilQuality(calculateQuality(selected, getEquippedCatalysts(), data.multipliers));
}

function craftPotion() {
  const quality = getPreviewQuality();
  const { kept } = processSelected(state.hand, state.selectedIds);
  const replenished = replenishHand(kept, state.deck, RULES.handSize);
  const order = applyCraftToOrder(state.order, quality);
  state = {
    ...state,
    hand: replenished.hand,
    deck: replenished.deck,
    selectedIds: [],
    order,
    brewing: true,
    tutorialStep: state.tutorialStep === "craftConfirm" ? "discardSelect" : state.tutorialStep
  };
  render();
  brewTimer = window.setTimeout(() => {
    state = { ...state, brewing: false, result: order.status === "playing" ? null : order.status };
    if (order.status !== "playing") finalizeOrder(order.status);
    render();
  }, 650);
}

function discardMaterials() {
  const { kept } = processSelected(state.hand, state.selectedIds);
  const replenished = replenishHand(kept, state.deck, RULES.handSize);
  setState({
    hand: replenished.hand,
    deck: replenished.deck,
    selectedIds: [],
    order: applyDiscardToOrder(state.order),
    tutorialStep: state.tutorialStep === "discardConfirm" ? "catalyst" : state.tutorialStep
  });
}

function applyOrderReward() {
  if (state.order.type === "daily") {
    state = { ...state, dailyCompleted: true, currencies: { ...state.currencies, alchemyCoin: state.currencies.alchemyCoin + 20 } };
  } else {
    state = { ...state, highestChallengeStep: Math.max(state.highestChallengeStep, state.order.step) };
  }
}

function finalizeOrder(status) {
  if (status === "success") applyOrderReward();
  if (status === "failed" && state.order.type === "daily") {
    state = { ...state, dailyCompleted: true };
  }
  if (state.order.type === "challenge") {
    state = { ...state, highestChallengeStep: Math.max(state.highestChallengeStep, state.order.step) };
  }
  state = {
    ...state,
    activeOrder: null,
    tutorialStep: status === "success" && ORDER_PLAY_TUTORIAL_STEPS.has(state.tutorialStep)
      ? "resultReturn"
      : state.tutorialStep
  };
}

function startNextChallenge() {
  state = { ...state, challengeStep: state.order.step + 1, result: null };
  startOrder("challenge");
}

function finishRun() {
  if (state.activeOrder && state.order?.status === "playing") {
    return setState({
      screen: "home",
      overlay: null,
      pendingOrderType: null,
      pendingOrderSeed: null,
      order: null,
      hand: [],
      deck: [],
      selectedIds: [],
      result: null
    });
  }
  const challengeStep = state.order?.type === "challenge" ? 1 : state.challengeStep;
  setState({
    screen: "home",
    order: null,
    hand: [],
    deck: [],
    selectedIds: [],
    result: null,
    challengeStep,
    activeOrder: null,
    tutorialStep: state.tutorialStep === "resultReturn" ? "shopHome" : state.tutorialStep
  });
}

function moveMaterial(templateId, direction) {
  const delta = direction === "add" ? 1 : -1;
  const nextCount = (state.materialBox[templateId] ?? 0) + delta;
  if (nextCount < 0 || nextCount > state.storage[templateId]) return;
  if (direction === "add" && getBoxSize() >= RULES.maximumBoxSize) return showToast("재료함에는 최대 99개까지 편성할 수 있습니다.");
  const tutorialStep = state.tutorialStep === "storageAdd" && direction === "add"
    ? "storageRemove"
    : state.tutorialStep === "storageRemove" && direction === "remove"
      ? "storageClose"
      : state.tutorialStep;
  setState({ materialBox: { ...state.materialBox, [templateId]: nextCount }, tutorialStep });
}

function toggleCatalyst(id) {
  const equipped = state.equippedCatalystIds.includes(id);
  if (!equipped && state.equippedCatalystIds.length >= RULES.maxCatalysts) return showToast("촉매는 최대 5개까지 장착할 수 있습니다.");
  setState({ equippedCatalystIds: equipped ? state.equippedCatalystIds.filter((item) => item !== id) : [...state.equippedCatalystIds, id] });
}

function buyMaterialPot() {
  const item = data.shopItems.find((entry) => entry.ItemType === "materialPot");
  if (state.currencies.magicCrystal < item.Price) return;
  const acquired = Array.from({ length: item.DropTable.Count }, () => rollMaterial(item.DropTable));
  const storage = acquired.reduce((next, material) => ({ ...next, [material.ID]: Math.min(99, next[material.ID] + 1) }), { ...state.storage });
  setState({
    storage,
    currencies: { ...state.currencies, magicCrystal: state.currencies.magicCrystal - item.Price },
    shopResult: acquired,
    tutorialStep: state.tutorialStep === "shopBuy" ? "potResult" : state.tutorialStep
  });
}

function closeShopResult() {
  setState({
    shopResult: null,
    tutorialStep: state.tutorialStep === "potResult" ? "closeShop" : state.tutorialStep
  });
}

function rollMaterial(dropTable) {
  const roll = rng();
  let cursor = 0;
  const grade = ["common", "uncommon", "rare", "unique", "legendary"].find((key) => {
    cursor += dropTable[key];
    return roll < cursor;
  }) ?? "legendary";
  const attributes = Object.keys(ATTRIBUTE);
  const attribute = attributes[Math.floor(rng() * attributes.length)];
  return data.materials.find((material) => material.Grade === grade && material.Attribute === attribute);
}

function buyCatalyst(id) {
  const item = data.shopItems.find((entry) => entry.ItemType === "catalystBox");
  if (state.ownedCatalystIds.includes(id) || state.currencies.magicCrystal < item.Price) return;
  const catalyst = data.catalysts.find((entry) => entry.ID === id);
  state = {
    ...state,
    ownedCatalystIds: [...state.ownedCatalystIds, id],
    currencies: { ...state.currencies, magicCrystal: state.currencies.magicCrystal - item.Price }
  };
  showToast(`${catalyst.Name}을 획득했습니다.`);
}

function getBoxSize() {
  return Object.values(state.materialBox).reduce((sum, count) => sum + count, 0);
}

function getEquippedCatalysts() {
  const equippedIds = state.activeOrder?.equippedCatalystIds ?? state.equippedCatalystIds;
  return data.catalysts.filter((catalyst) => equippedIds.includes(catalyst.ID));
}

function formatCatalystEffect(catalyst) {
  const attribute = ATTRIBUTE[catalyst.Attribute].name;
  return catalyst.EffectType === "attributeMultiplierAdd" ? `${attribute} 속성 배수 +${catalyst.EffectValue}` : `${attribute} 재료 등급 수치 +${catalyst.EffectValue}`;
}

function formatQuality(value) {
  return ceilQuality(value).toLocaleString("ko-KR");
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  state = { ...state, toast: message };
  render();
  toastTimer = window.setTimeout(() => { state = { ...state, toast: "" }; render(); }, 2400);
}

function scheduleDailyReset() {
  window.clearTimeout(dailyResetTimer);
  const now = Date.now();
  const delay = getNextDailyResetTimestamp(now, DAILY_RESET_HOUR) - now;
  dailyResetTimer = window.setTimeout(() => {
    const cycleKey = getDailyCycleKey(Date.now(), DAILY_RESET_HOUR);
    const reset = applyDailyCycle(state, cycleKey);
    if (reset.didReset) {
      if (reset.interruptedDailyOrder) window.clearTimeout(brewTimer);
      state = reset.interruptedDailyOrder
        ? {
            ...reset.progress,
            screen: "home",
            overlay: null,
            pendingOrderType: null,
            pendingOrderSeed: null,
            order: null,
            hand: [],
            deck: [],
            selectedIds: [],
            result: null
          }
        : reset.progress;
      showToast(reset.interruptedDailyOrder
        ? "오전 6시가 되어 진행 중이던 일일 의뢰가 종료되고 새 의뢰가 갱신되었습니다."
        : "오전 6시가 되어 일일 의뢰가 갱신되었습니다.");
    }
    scheduleDailyReset();
  }, delay);
}
