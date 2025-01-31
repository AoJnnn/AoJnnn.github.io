// Sakura falling animation v1.1
class Sakura {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.options = Object.assign({
        count: 30,          // 花瓣数量
        speed: 2,           // 飘落速度
        color: '#FFC0CB',   // 花瓣颜色
        size: 25,           // 最大尺寸
        wind: 0.5           // 风力影响
      }, options);
  
      this.petals = [];
      this.init();
    }
  
    init() {
      // 设置canvas尺寸
      this.resize();
      window.addEventListener('resize', () => this.resize());
  
      // 创建花瓣
      for(let i = 0; i < this.options.count; i++) {
        this.petals.push(this.createPetals());
      }
  
      // 开始动画
      this.animate();
    }
  
    createPetals() {
      return {
        x: Math.random() * this.canvas.width,
        y: -Math.random() * this.canvas.height,
        r: Math.random() * this.options.size + 5,  // 半径
        a: Math.random() * Math.PI,               // 角度
        s: Math.random() * 0.5 + 0.5,             // 速度
        c: this.options.color
      };
    }
  
    resize() {
      this.canvas.width = window.innerWidth;
      this.canvas.height = window.innerHeight;
    }
  
    drawPetals(petal) {
      // 绘制花瓣形状
      this.ctx.beginPath();
      this.ctx.moveTo(petal.x, petal.y);
      this.ctx.quadraticCurveTo(
        petal.x + petal.r/2, petal.y + petal.r/2,
        petal.x, petal.y + petal.r
      );
      this.ctx.quadraticCurveTo(
        petal.x - petal.r/2, petal.y + petal.r/2,
        petal.x, petal.y
      );
      this.ctx.closePath();
      
      // 填充颜色
      this.ctx.fillStyle = petal.c;
      this.ctx.globalAlpha = 0.7;
      this.ctx.fill();
    }
  
    updatePetals() {
      return this.petals.map(petal => {
        petal.y += petal.s * this.options.speed;
        petal.x += Math.sin(petal.a) * this.options.wind;
        petal.a += 0.01;
  
        if(petal.y > this.canvas.height) {
          return this.createPetals();
        }
        return petal;
      });
    }
  
    animate() {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.petals = this.updatePetals();
      this.petals.forEach(petal => this.drawPetals(petal));
      requestAnimationFrame(() => this.animate());
    }
  }
  
  // 自动初始化
  document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.top = 0;
    canvas.style.left = 0;
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = 9999;
    document.body.appendChild(canvas);
  
    new Sakura(canvas, {
      count: 35,              // 增加花瓣数量
      color: '#FFB6C1',       // 更柔和的粉色
      wind: 0.8               // 更强的风力效果
    });
  });