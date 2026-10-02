import AppKit
let output = CommandLine.arguments[1]
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor(calibratedRed: 0.125, green: 0.208, blue: 0.173, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 40, y: 40, width: 944, height: 944), xRadius: 210, yRadius: 210).fill()
let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 760, weight: .medium), .foregroundColor: NSColor.white]
let mark = "a" as NSString
let size = mark.size(withAttributes: attributes)
mark.draw(at: NSPoint(x: (1024 - size.width) / 2, y: (1024 - size.height) / 2 + 25), withAttributes: attributes)
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
