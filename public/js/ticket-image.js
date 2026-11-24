'use strict';

window.TicketImage = (() => {
  function wrapText(ctx, value, width) {
    const lines = [];
    let line = '';
    for (const word of value.match(/\S+|\s+/gu) || []) {
      if (ctx.measureText(line + word).width <= width) {
        line += word;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = '';
      for (const character of word.trimStart()) {
        if (line && ctx.measureText(line + character).width > width) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
    }
    if (line.trim()) lines.push(line.trim());
    return lines;
  }

  function ticketOutline(width, height, split) {
    const path = new Path2D();
    const corner = 14;
    const notch = 10;
    path.moveTo(corner, 0);
    path.lineTo(split - notch, 0);
    path.arc(split, 0, notch, Math.PI, 0, true);
    path.lineTo(width - corner, 0);
    path.quadraticCurveTo(width, 0, width, corner);
    path.lineTo(width, height - corner);
    path.quadraticCurveTo(width, height, width - corner, height);
    path.lineTo(split + notch, height);
    path.arc(split, height, notch, 0, Math.PI, true);
    path.lineTo(corner, height);
    path.quadraticCurveTo(0, height, 0, height - corner);
    path.lineTo(0, corner);
    path.quadraticCurveTo(0, 0, corner, 0);
    path.closePath();
    return path;
  }

  function drawPaper(ctx, width, height, split, ticket) {
    const ticketStyle = getComputedStyle(ticket);
    const stub = ticket.querySelector('.overview-ticket-stub');
    const ink = getComputedStyle(ticket.querySelector('h2')).color;
    ctx.fillStyle = ticketStyle.backgroundColor;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = getComputedStyle(stub).backgroundColor;
    ctx.fillRect(split, 0, width - split, height);

    ctx.save();
    ctx.strokeStyle = ink;
    ctx.globalAlpha = .065;
    for (let radius = 176; radius < width + height; radius += 17) {
      ctx.beginPath();
      ctx.ellipse(112, height + 51, radius, radius * .42, -.12, 0, Math.PI * 2);
      ctx.stroke();
    }
    const texture = document.createElement('canvas');
    texture.width = texture.height = 96;
    const grain = texture.getContext('2d');
    const dots = grain.createImageData(96, 96);
    for (let i = 0; i < dots.data.length; i += 4) {
      const shade = Math.random() * 255;
      dots.data[i] = dots.data[i + 1] = dots.data[i + 2] = shade;
      dots.data[i + 3] = Math.random() * 26;
    }
    grain.putImageData(dots, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = ctx.createPattern(texture, 'repeat');
    ctx.fillRect(0, 0, width, height);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = getComputedStyle(stub).borderLeftColor;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(split, 10);
    ctx.lineTo(split, height - 10);
    ctx.stroke();
    ctx.restore();
  }

  function drawPostmark(ctx, x, y, color, caption) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-Math.PI / 15);
    ctx.strokeStyle = ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, 32, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.arc(0, 0, 27, 0, Math.PI * 2);
    ctx.stroke();
    for (let offset = -8; offset <= 8; offset += 4) ctx.fillRect(36, offset, 25, 1);
    ctx.textAlign = 'center';
    ctx.font = '21px sans-serif';
    ctx.fillText('✈︎', 0, -17);
    ctx.font = '700 9px monospace';
    ctx.fillText(caption, 0, 6);
    ctx.restore();
  }

  function drawBarcode(ctx, x, y, color) {
    const widths = [1, 2, 2, 1, 1, 2, 3, 2, 1, 1, 2, 3];
    ctx.fillStyle = color;
    let offset = 0;
    for (let i = 0; offset < 146; i++) {
      const bar = widths[i % widths.length];
      if (i % 2 === 0) ctx.fillRect(x + offset, y, Math.min(bar, 146 - offset), 17);
      offset += bar;
    }
  }

  function drawTicket(ticket, title) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const width = 720, split = 466, margin = 8;
    const fontFamily = getComputedStyle(title).fontFamily;
    const text = [];
    const addText = (node, x, y, available, size, weight = 600, family = fontFamily) => {
      const font = `${weight} ${size}px ${family}`;
      ctx.font = font;
      const lines = wrapText(ctx, node.textContent.trim(), available);
      const lineHeight = Math.ceil(size * 1.42);
      text.push({ lines, font, lineHeight, x, y, color: getComputedStyle(node).color });
      return y + lines.length * lineHeight;
    };

    const destination = ticket.querySelector('.overview-ticket-destination');
    const titleBottom = addText(title, 26, 38, split - 155, 24, 700);
    const destinationLabel = addText(destination.querySelector('dt'), 26, Math.max(titleBottom + 10, 106), split - 52, 14);
    const mainBottom = addText(destination.querySelector('dd'), 26, destinationLabel + 2, split - 52, 38, 800);
    const stub = ticket.querySelector('.overview-ticket-stub');
    const [cycle, members, number] = stub.children;
    const stubX = split + 24;
    const stubWidth = width - stubX - 22;
    const cycleLabel = addText(cycle.querySelector('dt'), stubX, 24, stubWidth, 14);
    const cycleBottom = addText(cycle.querySelector('dd'), stubX, cycleLabel + 2, stubWidth, 19, 700);
    const membersLabel = addText(members.querySelector('dt'), stubX, cycleBottom + 10, stubWidth, 14);
    const membersBottom = addText(members.querySelector('dd'), stubX, membersLabel + 2, stubWidth, 19, 700);
    const barcodeY = membersBottom + 10;
    const numberLabel = number.querySelector('dt');
    addText(numberLabel, stubX, barcodeY + 23, 53, 11);
    const numberBottom = addText(number.querySelector('dd'), stubX + 55, barcodeY + 23, stubWidth - 55, 11, 700, 'monospace');
    const height = Math.max(224, mainBottom + 25, numberBottom + 21);

    const scale = Math.min(2, 4096 / Math.max(width + margin * 2, height + margin * 2));
    canvas.width = Math.floor((width + margin * 2) * scale);
    canvas.height = Math.floor((height + margin * 2) * scale);
    ctx.scale(scale, scale);
    ctx.translate(margin, margin);
    ctx.textBaseline = 'top';
    const outline = ticketOutline(width, height, split);
    ctx.clip(outline);
    drawPaper(ctx, width, height, split, ticket);
    ctx.strokeStyle = getComputedStyle(ticket).borderBottomColor;
    ctx.lineWidth = 2;
    ctx.stroke(outline);
    const mark = ticket.querySelector('.overview-ticket-postmark');
    drawPostmark(ctx, split - 79, 57, getComputedStyle(mark).color, mark.textContent.trim());
    drawBarcode(ctx, stubX, barcodeY, getComputedStyle(number, '::before').color);
    for (const block of text) {
      ctx.font = block.font;
      ctx.fillStyle = block.color;
      block.lines.forEach((line, i) => ctx.fillText(line, block.x, block.y + i * block.lineHeight));
    }
    return canvas;
  }

  async function save(ticket) {
    const title = ticket.querySelector('h2');
    const canvas = drawTicket(ticket, title);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('无法生成登机牌图片');
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const name = title.textContent.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 72) || '旅行';
    link.href = url;
    link.download = `${name}-登机牌.png`;
    document.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  return { save };
})();
