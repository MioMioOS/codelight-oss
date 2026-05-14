import UIKit

/// Downscales and JPEG-encodes images for upload.
enum ImageCompressor {
    /// Max long-edge pixels after downscale.
    static let maxDimension: CGFloat = 1280

    /// JPEG quality (0...1).
    static let jpegQuality: CGFloat = 0.72

    /// Load from PhotosPicker Data, downscale, return JPEG data.
    static func compress(_ original: Data) -> Data? {
        guard let image = UIImage(data: original) else { return nil }
        let resized = downscale(image)
        return resized.jpegData(compressionQuality: jpegQuality)
    }

    private static func downscale(_ image: UIImage) -> UIImage {
        let size = image.size
        let longEdge = max(size.width, size.height)
        guard longEdge > maxDimension else { return image }
        let scale = maxDimension / longEdge
        let newSize = CGSize(width: floor(size.width * scale), height: floor(size.height * scale))
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1 // don't upscale for retina — we already chose target pixels
        let renderer = UIGraphicsImageRenderer(size: newSize, format: format)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: newSize))
        }
    }
}
