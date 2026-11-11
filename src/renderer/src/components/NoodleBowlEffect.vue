<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { emojiToTwemojiCode, twemojiUrl } from '../utils/twemoji-assets'

// 面条表情（1f35c）直接复用内置 Twemoji，特效只负责「巨大化 + 加料 + 动效」。
const bowlUrl = twemojiUrl(emojiToTwemojiCode('🍜'))

const active = ref(false)
const run = ref(0)
let timer: number | null = null

// 固定角度散布，避免每次播放的随机形态不一致；14 颗刚好绕碗一圈。
const sparks = Array.from({ length: 14 }, (_, index) => {
  const angle = (index / 14) * Math.PI * 2
  const distance = 130 + (index % 4) * 34
  return {
    dx: Math.round(Math.cos(angle) * distance),
    dy: Math.round(Math.sin(angle) * distance * 0.72),
    delay: 0.24 + (index % 3) * 0.05
  }
})

function play(): void {
  // 连续触发时换 key 重新挂载，CSS 动画从头播放。
  run.value += 1
  active.value = true
  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    active.value = false
    timer = null
  }, 2900)
}

onBeforeUnmount(() => {
  if (timer !== null) window.clearTimeout(timer)
})

defineExpose({ play })
</script>

<template>
  <Teleport to="body">
    <div v-if="active" :key="run" class="noodle-layer" aria-hidden="true">
      <div class="noodle-glow"></div>
      <div class="noodle-stage">
        <div class="noodle-anchor">
          <div class="noodle-rays"></div>
          <span class="noodle-ring"></span>
          <span v-for="n in 4" :key="`steam-${n}`" class="noodle-steam" :class="`steam-${n}`"></span>
          <div class="noodle-bowl">
            <img class="noodle-bowl-img" :src="bowlUrl" alt="" draggable="false" />
            <svg class="noodle-toppings" viewBox="0 0 36 36">
              <!-- 海苔 -->
              <g class="topping nori">
                <path d="M27.9 12.1l2.5 1.3-3.6 6.4-2.4-1.4z" fill="#2E4A36" />
              </g>
              <!-- 牛肉片 -->
              <g class="topping beef-a">
                <g transform="rotate(-14 10 16.1)">
                  <ellipse cx="10" cy="16.6" rx="4.2" ry="2.6" fill="rgba(74, 26, 14, 0.22)" />
                  <ellipse cx="10" cy="16.1" rx="4.2" ry="2.6" fill="#8E3F2C" />
                  <ellipse cx="9.8" cy="15.8" rx="3.7" ry="2.1" fill="#A9503A" />
                  <path
                    d="M7 16.4c1.3-.8 3-.8 4.3 0M7.8 15c.9-.5 2.1-.5 3 0"
                    fill="none"
                    stroke="#CB7C60"
                    stroke-width="0.34"
                    stroke-linecap="round"
                  />
                </g>
              </g>
              <g class="topping beef-b">
                <g transform="rotate(12 13.6 21.2)">
                  <ellipse cx="13.6" cy="21.7" rx="3.8" ry="2.3" fill="rgba(74, 26, 14, 0.22)" />
                  <ellipse cx="13.6" cy="21.2" rx="3.8" ry="2.3" fill="#8E3F2C" />
                  <ellipse cx="13.4" cy="20.9" rx="3.3" ry="1.85" fill="#A9503A" />
                  <path
                    d="M11.1 21.4c1.2-.7 2.7-.7 3.9 0M11.8 20.2c.8-.5 1.9-.5 2.7 0"
                    fill="none"
                    stroke="#CB7C60"
                    stroke-width="0.32"
                    stroke-linecap="round"
                  />
                </g>
              </g>
              <!-- 溏心蛋 -->
              <g class="topping egg">
                <g transform="rotate(-8 24.4 15.9)">
                  <ellipse cx="24.4" cy="16.4" rx="3.5" ry="2.6" fill="rgba(74, 26, 14, 0.18)" />
                  <ellipse cx="24.4" cy="15.9" rx="3.5" ry="2.6" fill="#FFF8EA" stroke="#E8D9BE" stroke-width="0.22" />
                  <ellipse cx="24.8" cy="15.7" rx="1.55" ry="1.25" fill="#FFC233" />
                  <ellipse cx="24.45" cy="15.35" rx="0.55" ry="0.4" fill="#FFE08A" />
                </g>
              </g>
              <!-- 鸣门卷 -->
              <g class="topping naruto">
                <circle cx="20" cy="21.7" r="2.3" fill="rgba(74, 26, 14, 0.18)" />
                <circle cx="20" cy="21.3" r="2.3" fill="#FFF4F0" stroke="#F0CFC7" stroke-width="0.22" />
                <path
                  d="M20 21.3c0.9-0.5 1.6 0.4 1 1.1-0.7 0.8-2 0.2-1.8-0.9 0.2-1.3 1.9-1.7 2.7-0.7"
                  fill="none"
                  stroke="#F28C9C"
                  stroke-width="0.45"
                  stroke-linecap="round"
                />
              </g>
              <!-- 葱花与芝麻 -->
              <g class="topping greens" fill="#6CBF56">
                <circle cx="12.4" cy="14.1" r="0.44" />
                <circle cx="16.6" cy="18.2" r="0.38" />
                <circle cx="22.8" cy="19.1" r="0.4" />
                <circle cx="26.9" cy="18.4" r="0.36" />
                <circle cx="15" cy="23.2" r="0.34" />
              </g>
              <g class="topping sesame" fill="#FFFDF2">
                <circle cx="19.2" cy="13.9" r="0.26" />
                <circle cx="21.8" cy="17.3" r="0.22" />
                <circle cx="10.8" cy="19.9" r="0.24" />
                <circle cx="25.9" cy="21.9" r="0.22" />
              </g>
            </svg>
          </div>
          <i
            v-for="(spark, index) in sparks"
            :key="index"
            class="noodle-spark"
            :style="{
              '--dx': `${spark.dx}px`,
              '--dy': `${spark.dy}px`,
              animationDelay: `${spark.delay}s`
            }"
          ></i>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.noodle-layer {
  position: fixed;
  inset: 0;
  z-index: 60;
  overflow: hidden;
  pointer-events: none;
}
.noodle-glow {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(circle at 50% 54%, rgba(255, 202, 96, 0.42), rgba(255, 152, 56, 0.16) 38%, transparent 64%);
  opacity: 0;
  animation: noodle-glow 2.9s ease-out forwards;
}
.noodle-stage {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
}
.noodle-anchor {
  position: absolute;
  left: 0;
  top: 0;
  width: clamp(300px, 54vw, 540px);
  aspect-ratio: 1;
  transform: translate(-50%, -50%);
}
.noodle-rays {
  position: absolute;
  inset: -18%;
  background: repeating-conic-gradient(
    from 0deg,
    rgba(255, 214, 102, 0.34) 0deg 7deg,
    transparent 7deg 20deg
  );
  -webkit-mask-image: radial-gradient(circle, #000 0 36%, transparent 68%);
  mask-image: radial-gradient(circle, #000 0 36%, transparent 68%);
  opacity: 0;
  animation: noodle-rays 2.9s ease-out forwards;
}
.noodle-bowl {
  position: absolute;
  inset: 8%;
  width: 84%;
  height: 84%;
  transform-origin: 50% 68%;
  filter: drop-shadow(0 30px 54px rgba(255, 132, 32, 0.42));
  animation: noodle-bowl 2.9s cubic-bezier(0.22, 0.9, 0.24, 1) forwards;
}
.noodle-bowl-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.noodle-toppings {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.topping {
  opacity: 0;
  transform-box: fill-box;
  transform-origin: center;
  animation: noodle-topping-in 0.5s cubic-bezier(0.2, 1.3, 0.4, 1) forwards;
}
.nori {
  animation-delay: 0.22s;
}
.beef-a {
  animation-delay: 0.28s;
}
.beef-b {
  animation-delay: 0.36s;
}
.egg {
  animation-delay: 0.44s;
}
.naruto {
  animation-delay: 0.52s;
}
.greens {
  animation-delay: 0.58s;
}
.sesame {
  animation-delay: 0.64s;
}
.noodle-ring {
  position: absolute;
  left: 50%;
  top: 76%;
  width: 150px;
  height: 38px;
  margin: -19px 0 0 -75px;
  border: 3px solid rgba(255, 201, 94, 0.85);
  border-radius: 50%;
  opacity: 0;
  animation: noodle-ring 0.9s ease-out 0.16s forwards;
}
.noodle-steam {
  position: absolute;
  width: 18px;
  height: 92px;
  border-radius: 50%;
  background: linear-gradient(
    to top,
    rgba(255, 255, 255, 0),
    rgba(255, 255, 255, 0.95),
    rgba(255, 240, 206, 0)
  );
  filter: blur(7px) drop-shadow(0 0 10px rgba(255, 190, 90, 0.55));
  opacity: 0;
  animation: noodle-steam 1.5s ease-out infinite;
}
.steam-1 {
  left: 33%;
  top: 4%;
  animation-delay: 0.3s;
}
.steam-2 {
  left: 47%;
  top: 0;
  height: 104px;
  animation-delay: 0.55s;
}
.steam-3 {
  left: 61%;
  top: 5%;
  animation-delay: 0.8s;
}
.steam-4 {
  left: 40%;
  top: 2%;
  height: 78px;
  animation-delay: 1.05s;
}
.noodle-spark {
  position: absolute;
  left: 50%;
  top: 52%;
  width: 10px;
  height: 10px;
  margin: -5px 0 0 -5px;
  border-radius: 50%;
  background: #fff6dc;
  box-shadow: 0 0 16px rgba(255, 170, 60, 0.95);
  opacity: 0;
  animation: noodle-spark 1.1s ease-out forwards;
}
@keyframes noodle-glow {
  0% {
    opacity: 0;
  }
  16% {
    opacity: 1;
  }
  62% {
    opacity: 0.85;
  }
  100% {
    opacity: 0;
  }
}
@keyframes noodle-rays {
  0% {
    opacity: 0;
    transform: scale(0.6) rotate(0deg);
  }
  18% {
    opacity: 0.9;
  }
  70% {
    opacity: 0.55;
  }
  100% {
    opacity: 0;
    transform: scale(1.15) rotate(20deg);
  }
}
@keyframes noodle-bowl {
  0% {
    opacity: 0;
    transform: translateY(42vh) scale(0.22) rotate(-16deg);
  }
  14% {
    opacity: 1;
    transform: translateY(-3vh) scale(1.1) rotate(4deg);
  }
  22% {
    transform: translateY(0) scale(0.97) rotate(-2deg);
  }
  30% {
    transform: translateY(-1vh) scale(1.03) rotate(1deg);
  }
  38% {
    transform: translateY(0) scale(1) rotate(0deg);
  }
  46% {
    transform: rotate(-1.4deg) scale(1.01);
  }
  52% {
    transform: rotate(1.2deg);
  }
  58% {
    transform: rotate(-0.8deg);
  }
  64% {
    transform: rotate(0.5deg);
  }
  70% {
    transform: rotate(0deg);
  }
  80% {
    opacity: 1;
    transform: translateY(0) scale(1.01);
  }
  100% {
    opacity: 0;
    transform: translateY(-7vh) scale(1.16);
  }
}
@keyframes noodle-ring {
  0% {
    opacity: 0;
    transform: scale(0.3);
  }
  18% {
    opacity: 0.9;
  }
  100% {
    opacity: 0;
    transform: scale(2.6);
  }
}
@keyframes noodle-topping-in {
  from {
    opacity: 0;
    transform: scale(0.5);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
@keyframes noodle-steam {
  0% {
    opacity: 0;
    transform: translateY(22px) scale(0.6);
  }
  30% {
    opacity: 0.85;
  }
  100% {
    opacity: 0;
    transform: translateY(-96px) scale(1.25);
  }
}
@keyframes noodle-spark {
  0% {
    opacity: 0;
    transform: translate(0, 0) scale(0.3);
  }
  18% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: translate(var(--dx), var(--dy)) scale(0.5);
  }
}
@media (prefers-reduced-motion: reduce) {
  .noodle-glow {
    animation: noodle-glow 2.2s ease-out forwards;
  }
  .noodle-bowl {
    animation: noodle-fade 2.2s ease-out forwards;
  }
  .noodle-rays,
  .noodle-steam,
  .noodle-spark,
  .noodle-ring {
    display: none;
  }
  .topping {
    animation: none;
    opacity: 1;
  }
}
@keyframes noodle-fade {
  0%,
  100% {
    opacity: 0;
    transform: scale(1);
  }
  12%,
  82% {
    opacity: 1;
  }
}
</style>
