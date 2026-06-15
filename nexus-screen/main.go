//go:build windows

// nexus-screen — captura DXGI + injeção de input para Nexus RMM
// Serve WebSocket local em 127.0.0.1:7701
//
// Frames (binário, helper → relay → viewer):
//   [0x01][4B width LE][4B height LE][JPEG data]
//
// Comandos (JSON, viewer → relay → helper):
//   {"cmd":"mouse","x":0.5,"y":0.3,"buttons":1,"move":true}
//   {"cmd":"mouseup","buttons":1}
//   {"cmd":"scroll","x":0.5,"y":0.3,"delta":-3}
//   {"cmd":"key","vk":65,"down":true}
//   {"cmd":"qualidade","q":75}
//   {"cmd":"monitor","idx":0}
//   {"cmd":"fps","v":30}

package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/jpeg"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/gorilla/websocket"
	"github.com/kbinani/screenshot"
)

// ── Windows API ───────────────────────────────────────────────────────────────

var (
	user32           = syscall.NewLazyDLL("user32.dll")
	procSendInput    = user32.NewProc("SendInput")
	procGetSysMetric = user32.NewProc("GetSystemMetrics")
)

const (
	INPUT_MOUSE    = uint32(0)
	INPUT_KEYBOARD = uint32(1)

	MOUSEEVENTF_MOVE        = uint32(0x0001)
	MOUSEEVENTF_LEFTDOWN    = uint32(0x0002)
	MOUSEEVENTF_LEFTUP      = uint32(0x0004)
	MOUSEEVENTF_RIGHTDOWN   = uint32(0x0008)
	MOUSEEVENTF_RIGHTUP     = uint32(0x0010)
	MOUSEEVENTF_MIDDLEDOWN  = uint32(0x0020)
	MOUSEEVENTF_MIDDLEUP    = uint32(0x0040)
	MOUSEEVENTF_WHEEL       = uint32(0x0800)
	MOUSEEVENTF_ABSOLUTE    = uint32(0x8000)
	MOUSEEVENTF_VIRTUALDESK = uint32(0x4000)

	KEYEVENTF_KEYUP = uint32(0x0002)

	SM_XVIRTUALSCREEN  = 76
	SM_YVIRTUALSCREEN  = 77
	SM_CXVIRTUALSCREEN = 78
	SM_CYVIRTUALSCREEN = 79
)

func getSysMetric(n int) int {
	r, _, _ := procGetSysMetric.Call(uintptr(n))
	return int(int32(r))
}

// sendMouseInput usa struct raw (byte array) para evitar problemas de alinhamento.
// Layout INPUT no Windows x64: type(4), pad(4), dx(4), dy(4), mouseData(4), dwFlags(4), time(4), pad(4), extra(8) = 40 bytes
func sendMouseInput(dx, dy int32, flags, mouseData uint32) {
	var inp [40]byte
	binary.LittleEndian.PutUint32(inp[0:], INPUT_MOUSE)
	// inp[4:8] = 0 (pad)
	binary.LittleEndian.PutUint32(inp[8:], uint32(dx))
	binary.LittleEndian.PutUint32(inp[12:], uint32(dy))
	binary.LittleEndian.PutUint32(inp[16:], mouseData)
	binary.LittleEndian.PutUint32(inp[20:], flags)
	// time = 0, pad = 0, extra = 0
	procSendInput.Call(1, uintptr(unsafe.Pointer(&inp[0])), 40)
}

// Layout KEYBDINPUT em INPUT x64: type(4), pad(4), vk(2), scan(2), dwFlags(4), time(4), pad(4), pad(4), extra(8) = 40 bytes
func sendKeyInput(vk uint16, down bool) {
	var inp [40]byte
	binary.LittleEndian.PutUint32(inp[0:], INPUT_KEYBOARD)
	// inp[4:8] = 0 (pad)
	binary.LittleEndian.PutUint16(inp[8:], vk)
	// wScan = 0
	flags := uint32(0)
	if !down {
		flags = KEYEVENTF_KEYUP
	}
	binary.LittleEndian.PutUint32(inp[12:], flags)
	// time, pad, extra = 0
	procSendInput.Call(1, uintptr(unsafe.Pointer(&inp[0])), 40)
}

// normToAbsolute converte coordenada normalizada (0-1) do monitor para o espaço ABSOLUTE (0-65535) do virtual desktop.
func normToAbsolute(relX, relY float64, mon image.Rectangle) (dx, dy int32) {
	vx := getSysMetric(SM_XVIRTUALSCREEN)
	vy := getSysMetric(SM_YVIRTUALSCREEN)
	vw := getSysMetric(SM_CXVIRTUALSCREEN)
	vh := getSysMetric(SM_CYVIRTUALSCREEN)
	if vw <= 0 {
		vw = 1920
	}
	if vh <= 0 {
		vh = 1080
	}

	// pixel absoluto no virtual desktop
	px := float64(mon.Min.X) + relX*float64(mon.Dx())
	py := float64(mon.Min.Y) + relY*float64(mon.Dy())

	dx = int32((px - float64(vx)) * 65535.0 / float64(vw-1))
	dy = int32((py - float64(vy)) * 65535.0 / float64(vh-1))
	return
}

// ── estado global ─────────────────────────────────────────────────────────────

type captureState struct {
	mu      sync.RWMutex
	quality int
	fps     int
	monIdx  int // 0..N-1
}

var state = &captureState{quality: 65, fps: 30, monIdx: 0}

var upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

// ── main ──────────────────────────────────────────────────────────────────────

func main() {
	port := "127.0.0.1:7701"
	if len(os.Args) > 1 {
		port = os.Args[1]
	}
	log.SetFlags(log.Ltime | log.Lshortfile)
	log.Printf("nexus-screen iniciando em ws://%s", port)

	n := screenshot.NumActiveDisplays()
	log.Printf("monitores: %d", n)
	for i := 0; i < n; i++ {
		b := screenshot.GetDisplayBounds(i)
		log.Printf("  [%d] %dx%d @ (%d,%d)", i, b.Dx(), b.Dy(), b.Min.X, b.Min.Y)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handleWS)
	mux.HandleFunc("/monitores", handleMonitores)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })

	ln, err := net.Listen("tcp", port)
	if err != nil {
		log.Fatalf("porta %s indisponível: %v", port, err)
	}
	log.Printf("✓ ouvindo em %s", port)
	if err := http.Serve(ln, mux); err != nil {
		log.Fatal(err)
	}
}

// ── /monitores ────────────────────────────────────────────────────────────────

func handleMonitores(w http.ResponseWriter, r *http.Request) {
	n := screenshot.NumActiveDisplays()
	type mon struct {
		Idx int `json:"idx"`
		W   int `json:"w"`
		H   int `json:"h"`
		X   int `json:"x"`
		Y   int `json:"y"`
	}
	lista := make([]mon, 0, n)
	for i := 0; i < n; i++ {
		b := screenshot.GetDisplayBounds(i)
		lista = append(lista, mon{i, b.Dx(), b.Dy(), b.Min.X, b.Min.Y})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(lista)
}

// ── /ws ───────────────────────────────────────────────────────────────────────

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}
	defer conn.Close()
	log.Println("viewer conectado")

	cmdCh := make(chan map[string]interface{}, 16)
	go func() {
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				close(cmdCh)
				return
			}
			var cmd map[string]interface{}
			if json.Unmarshal(msg, &cmd) == nil {
				cmdCh <- cmd
			}
		}
	}()

	state.mu.RLock()
	ticker := time.NewTicker(time.Second / time.Duration(state.fps))
	state.mu.RUnlock()
	defer ticker.Stop()

	var lastHash uint64
	var prevButtons float64

	for {
		select {
		case cmd, ok := <-cmdCh:
			if !ok {
				log.Println("viewer desconectado")
				return
			}
			handleCmd(cmd, ticker, &prevButtons)

		case <-ticker.C:
			state.mu.RLock()
			q := state.quality
			idx := state.monIdx
			state.mu.RUnlock()

			img, err := captureMonitor(idx)
			if err != nil || img == nil {
				continue
			}
			h := quickHash(img)
			if h == lastHash {
				continue
			}
			lastHash = h

			frame, err := encodeJPEG(img, q)
			if err != nil {
				continue
			}
			pkt := buildPacket(img.Bounds().Dx(), img.Bounds().Dy(), frame)
			if err := conn.WriteMessage(websocket.BinaryMessage, pkt); err != nil {
				log.Printf("send: %v", err)
				return
			}
		}
	}
}

// ── captura ───────────────────────────────────────────────────────────────────

func captureMonitor(idx int) (*image.RGBA, error) {
	n := screenshot.NumActiveDisplays()
	if n == 0 {
		return nil, nil
	}
	if idx < 0 || idx >= n {
		idx = 0
	}
	return screenshot.CaptureDisplay(idx)
}

// ── encode ────────────────────────────────────────────────────────────────────

func encodeJPEG(img image.Image, quality int) ([]byte, error) {
	var buf bytes.Buffer
	err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality})
	return buf.Bytes(), err
}

func buildPacket(w, h int, jpegData []byte) []byte {
	pkt := make([]byte, 9+len(jpegData))
	pkt[0] = 0x01
	binary.LittleEndian.PutUint32(pkt[1:5], uint32(w))
	binary.LittleEndian.PutUint32(pkt[5:9], uint32(h))
	copy(pkt[9:], jpegData)
	return pkt
}

// ── hash ──────────────────────────────────────────────────────────────────────

func quickHash(img *image.RGBA) uint64 {
	if img == nil {
		return 0
	}
	const (
		offset = 14695981039346656037
		prime  = 1099511628211
	)
	h := uint64(offset)
	pix := img.Pix
	for i := 0; i < len(pix); i += 64 {
		h ^= uint64(pix[i])
		h *= prime
	}
	return h
}

// ── comandos ──────────────────────────────────────────────────────────────────

func handleCmd(cmd map[string]interface{}, ticker *time.Ticker, prevButtons *float64) {
	c, _ := cmd["cmd"].(string)

	switch c {
	case "qualidade":
		if v, ok := cmd["q"].(float64); ok && v >= 1 && v <= 95 {
			state.mu.Lock()
			state.quality = int(v)
			state.mu.Unlock()
		}

	case "monitor":
		if v, ok := cmd["idx"].(float64); ok {
			state.mu.Lock()
			state.monIdx = int(v)
			state.mu.Unlock()
		}

	case "fps":
		if v, ok := cmd["v"].(float64); ok && v >= 1 && v <= 60 {
			state.mu.Lock()
			state.fps = int(v)
			dur := time.Second / time.Duration(state.fps)
			state.mu.Unlock()
			ticker.Reset(dur)
		}

	case "mouse":
		relX, _ := cmd["x"].(float64)
		relY, _ := cmd["y"].(float64)
		buttons, _ := cmd["buttons"].(float64)

		state.mu.RLock()
		idx := state.monIdx
		state.mu.RUnlock()

		n := screenshot.NumActiveDisplays()
		if idx < 0 || idx >= n {
			idx = 0
		}
		mon := screenshot.GetDisplayBounds(idx)
		dx, dy := normToAbsolute(relX, relY, mon)

		// move
		sendMouseInput(dx, dy, MOUSEEVENTF_MOVE|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK, 0)

		// botões — detectar mudanças
		prev := *prevButtons
		*prevButtons = buttons

		// botão esquerdo
		if int(buttons)&1 != 0 && int(prev)&1 == 0 {
			sendMouseInput(dx, dy, MOUSEEVENTF_LEFTDOWN|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK, 0)
		} else if int(buttons)&1 == 0 && int(prev)&1 != 0 {
			sendMouseInput(dx, dy, MOUSEEVENTF_LEFTUP|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK, 0)
		}
		// botão direito
		if int(buttons)&2 != 0 && int(prev)&2 == 0 {
			sendMouseInput(dx, dy, MOUSEEVENTF_RIGHTDOWN|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK, 0)
		} else if int(buttons)&2 == 0 && int(prev)&2 != 0 {
			sendMouseInput(dx, dy, MOUSEEVENTF_RIGHTUP|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK, 0)
		}
		// botão do meio
		if int(buttons)&4 != 0 && int(prev)&4 == 0 {
			sendMouseInput(dx, dy, MOUSEEVENTF_MIDDLEDOWN|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK, 0)
		} else if int(buttons)&4 == 0 && int(prev)&4 != 0 {
			sendMouseInput(dx, dy, MOUSEEVENTF_MIDDLEUP|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK, 0)
		}

	case "mouseup":
		buttons, _ := cmd["buttons"].(float64)
		*prevButtons = 0
		if int(buttons)&1 != 0 {
			sendMouseInput(0, 0, MOUSEEVENTF_LEFTUP, 0)
		}
		if int(buttons)&2 != 0 {
			sendMouseInput(0, 0, MOUSEEVENTF_RIGHTUP, 0)
		}
		if int(buttons)&4 != 0 {
			sendMouseInput(0, 0, MOUSEEVENTF_MIDDLEUP, 0)
		}

	case "scroll":
		relX, _ := cmd["x"].(float64)
		relY, _ := cmd["y"].(float64)
		delta, _ := cmd["delta"].(float64)

		state.mu.RLock()
		idx := state.monIdx
		state.mu.RUnlock()

		n := screenshot.NumActiveDisplays()
		if idx < 0 || idx >= n {
			idx = 0
		}
		mon := screenshot.GetDisplayBounds(idx)
		dx, dy := normToAbsolute(relX, relY, mon)
		// delta do browser: -3 = scroll down → Windows espera valor em múltiplos de 120
		wheelData := int32(delta * -120)
		sendMouseInput(dx, dy,
			MOUSEEVENTF_WHEEL|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK,
			uint32(wheelData))

	case "key":
		vkRaw, _ := cmd["vk"].(float64)
		down, _ := cmd["down"].(bool)
		vk := uint16(vkRaw)
		if vk > 0 {
			sendKeyInput(vk, down)
		}
	}
}
